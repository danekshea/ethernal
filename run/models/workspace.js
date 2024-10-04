'use strict';
const {
  Model,
  Sequelize,
  QueryTypes,
} = require('sequelize');
const moment = require('moment');
const { sanitize, slugify, processRawRpcObject } = require('../lib/utils');
const { ProviderConnector } = require('../lib/rpc');
const logger = require('../lib/logger');
const { getMaxBlockForSyncReset } = require('../lib/env');
const Analytics = require('../lib/analytics');

const Op = Sequelize.Op;
const INTEGRATION_FIELD_MAPPING = {
    'alchemy': 'alchemyIntegrationEnabled'
};

module.exports = (sequelize, DataTypes) => {
  class Workspace extends Model {
    static associate(models) {
      Workspace.belongsTo(models.User, { foreignKey: 'userId', as: 'user' });
      Workspace.hasOne(models.IntegrityCheck, { foreignKey: 'workspaceId', as: 'integrityCheck' });
      Workspace.hasOne(models.RpcHealthCheck, { foreignKey: 'workspaceId', as: 'rpcHealthCheck' });
      Workspace.hasOne(models.Explorer, { foreignKey: 'workspaceId', as: 'explorer' });
      Workspace.hasMany(models.CustomField, { foreignKey: 'workspaceId', as: 'custom_fields' });
      Workspace.hasMany(models.Block, { foreignKey: 'workspaceId', as: 'blocks' });
      Workspace.hasMany(models.Transaction, { foreignKey: 'workspaceId', as: 'transactions' });
      Workspace.hasMany(models.TransactionReceipt, { foreignKey: 'workspaceId', as: 'receipts' });
      Workspace.hasMany(models.TransactionLog, { foreignKey: 'workspaceId', as: 'logs' });
      Workspace.hasMany(models.Contract, { foreignKey: 'workspaceId', as: 'contracts' });
      Workspace.hasMany(models.Account, { foreignKey: 'workspaceId', as: 'accounts' });
      Workspace.hasMany(models.TokenBalanceChange, { foreignKey: 'workspaceId', as: 'tokenBalanceChanges' });
      Workspace.hasMany(models.TokenTransfer, { foreignKey: 'workspaceId', as: 'tokenTransfers' });
    }

    static findPublicWorkspaceById(id) {
        return Workspace.findOne({
            where: {
                public: true,
                id: id
            }
        });
    }

    static findByUserIdAndName(userId, name) {
        return Workspace.findOne({
            where: {
                userId: userId,
                name: name
            }
        });
    }

    getProvider() {
        return new ProviderConnector(this.rpcServer);
    }

    async safeDelete() {
        const blocks = await this.getBlocks({ limit: getMaxBlockForSyncReset() });
        if (blocks.length == getMaxBlockForSyncReset())
            throw new Error('Please reset this workspace before deleting it.');

        const explorer = await this.getExplorer();
        if (explorer)
            throw new Error(`This workspace has an explorer associated to it. Please delete it or change its associated workspace first.`);

        const transaction = await sequelize.transaction();
        try {
            const user = await this.getUser();
            if (user.currentWorkspaceId == this.id) {
                const workspaces = (await user.getWorkspaces()).filter(w => w.id != this.id);
                const currentWorkspaceId = workspaces.length ? workspaces[0].id : null;
                await user.update({ currentWorkspaceId });
            }
            await this.reset(null, transaction);
            await sequelize.models.CustomField.destroy({ where: { workspaceId: this.id }}, { transaction });
            await this.destroy({ transaction });

            await transaction.commit();
        } catch(error) {
            await transaction.rollback();
            throw error;
        }
    }

    async getContractByAddress(address) {
        if (!address) throw new Error('Missing parameter');

        const contracts = await this.getContracts({
            where: { address }
        });

        return contracts[0];
    }

    findBlockGaps(lowerBound, upperBound) {
        if (lowerBound === undefined || lowerBound === null || upperBound === undefined || upperBound === null)
            throw new Error('Missing parameter');

        return sequelize.query(`
            SELECT * FROM (
                SELECT
                    LAG(MAX("number")) OVER (order by group_id) + 1 AS "blockStart",
                    MIN("number") - 1 AS "blockEnd"
                FROM (  
                    SELECT
                        "workspaceId", "number",
                        "number" - row_number() OVER (ORDER BY "number") as group_id
                    FROM blocks
                    WHERE "workspaceId" = :workspaceId
                    AND number >= :lowerBound
                    AND number <= :upperBound
                ) s
                GROUP BY group_id
            ) q
            WHERE "blockStart" IS NOT NULL;
        `, {
            replacements: {
                workspaceId: this.id,
                lowerBound: lowerBound,
                upperBound: upperBound
            },
            type: QueryTypes.SELECT
        });
    }

    async safeCreateOrUpdateRpcHealthCheck(isReachable) {
        if (isReachable === null || isReachable === undefined)
            throw new Error('Missing parameter');

        const rpcHealthCheck = await this.getRpcHealthCheck();

        if (rpcHealthCheck) {
            // This is necessary otherwise Sequelize won't update the value with no other changes
            rpcHealthCheck.changed('updatedAt', true);

            // If rpc is reachable we reset failed attempts as well
            const fields = isReachable ? { isReachable, failedAttempts: 0, updatedAt: new Date() } : { isReachable, updatedAt: new Date() }
            return rpcHealthCheck.update(fields);
        }
        else
            return this.createRpcHealthCheck({ isReachable });
    }

    async safeCreateOrUpdateIntegrityCheck({ blockId, status }) {
        if (!blockId && !status) throw new Error('Missing parameter');

        const integrityCheck = await this.getIntegrityCheck();

        if (integrityCheck)
            return integrityCheck.update(sanitize({ blockId, status }));
        else
            return this.createIntegrityCheck(sanitize({ blockId, status }));
    }

    async safeDeleteIntegrityCheck() {
        const integrityCheck = await this.getIntegrityCheck();
        if (integrityCheck)
            return integrityCheck.destroy();
    }

    async getCustomTransactionFunction() {
       const custom_field = await sequelize.models.CustomField.findOne({
           where: {
               workspaceId: this.id,
               location: 'transaction'
           }
       });

       return custom_field ? custom_field.function : null;
    }

    async getExpiredBlocks(ttlInMinutes = 15) {
        const blocks = await sequelize.query(`
            SELECT b.id, b."createdAt"
            FROM blocks b
            LEFT JOIN (
                SELECT "blockNumber", COUNT(*) AS txn_count
                FROM transactions
                WHERE "workspaceId" = :workspaceId
                AND state = 'ready'
                GROUP BY "blockNumber"
            ) t ON b.number = t."blockNumber"
            WHERE b."workspaceId" = :workspaceId
            AND (t.txn_count IS NULL OR t.txn_count <> b."transactionsCount");
        `, {
            model: sequelize.models.Block,
            replacements: { workspaceId: this.id }
        });

        // We do this on purpose here, this avoid creating an index on the table, and we shouldn't have a lot of records to filter through anyway
        return blocks.filter(b => moment().diff(b.createdAt, 'minutes') >= ttlInMinutes);
    }

    getFilteredAddressTokenTransfers(address, page = 1, itemsPerPage = 10, orderBy = 'id', order = 'DESC') {
        if (!address) throw new Error('Missing parameter');

        let sanitizedOrderBy;
        switch(orderBy) {
            case 'timestamp':
            case 'transactionHash':
            case 'blockNumber':
                sanitizedOrderBy = ['transaction', orderBy];
                break;
            case 'amount':
                sanitizedOrderBy = [sequelize.cast(sequelize.col('"TokenTransfer".amount'), 'numeric')];
                break;
            default:
                sanitizedOrderBy = [orderBy];
                break;
        }

        return this.getTokenTransfers({
            where: {
                [Op.or]: [
                    { src: address.toLowerCase() },
                    { dst: address.toLowerCase() }
                ]
            },
            include: [
                {
                    model: sequelize.models.Transaction,
                    as: 'transaction',
                    attributes: ['hash', 'blockNumber', 'timestamp']
                },
                {
                    model: sequelize.models.Contract,
                    as: 'contract',
                    attributes: ['id', 'patterns', 'tokenName', 'tokenSymbol', 'tokenDecimals', 'abi']
                }
            ],
            attributes: ['id', 'src', 'dst', 'token', [sequelize.cast(sequelize.col('"TokenTransfer".amount'), 'numeric'), 'amount']],
            offset: (page - 1) * itemsPerPage,
            limit: itemsPerPage,
            order: [[...sanitizedOrderBy, order]]
        })
    }

    countAddressTokenTransfers(address) {
        if (!address) throw new Error('Missing parameter');

        return this.countTokenTransfers({
            where: {
                [Op.or]: [
                    { src: address.toLowerCase() },
                    { dst: address.toLowerCase() }
                ]
            }
        });
    }

    countAddressSentTransactions(address) {
        if (!address) throw new Error('Missing parameter');

        return this.countTransactions({
            where: { from: address.toLowerCase() }
        });
    }

    countAddressReceivedTransactions(address) {
        if (!address) throw new Error('Missing parameter');

        return this.countTransactions({
            where: { to: address.toLowerCase() }
        });
    }

    countAddressSentErc20TokenTransfers(address) {
        if (!address) throw new Error('Missing parameter');

        return this.countTokenTransfers({
            where: {
                src: address.toLowerCase(),
                tokenId: null
            }
        });
    }

    countAddressReceivedErc20TokenTransfers(address) {
        if (!address) throw new Error('Missing parameter');

        return this.countTokenTransfers({
            where: {
                dst: address.toLowerCase(),
                tokenId: null
            }
        });
    }

    async getTransactionCount(since) {
        let query = `
            SELECT COALESCE(SUM(count), 0) AS count
            FROM transaction_events
            WHERE "workspaceId" = :workspaceId
                AND timestamp >= timestamp :since
        `;

        if (!since) {
            const [earliestBlock] = await this.getBlocks({
                attributes: ['timestamp'],
                where: {
                    timestamp: { [Op.gt]: new Date(0) }
                },
                order: [['number', 'ASC']],
                limit: 1
            });
            since = earliestBlock ? new Date(earliestBlock.timestamp) : new Date(0);
        }

        const [{ count },] = await sequelize.query(query, {
            replacements: {
                workspaceId: this.id,
                since
            },
            type: QueryTypes.SELECT
        });

        return parseInt(count);
    }

    async getTransactionVolume(from, to) {
        if (!from || !to) throw new Error('Missing parameter');

        const [earliestBlock] = await this.getBlocks({
            attributes: ['timestamp'],
            where: {
                timestamp: { [Op.gt]: new Date(0) }
            },
            order: [['number', 'ASC']],
            limit: 1
        });

        if (!earliestBlock && +new Date(from) == 0)
            return [];

        const earliestTimestamp = +new Date(from) == 0 ? earliestBlock.timestamp : new Date(from);

        const [transactions,] = await sequelize.query(`
            WITH date_series AS (
                SELECT generate_series(
                    DATE_TRUNC('day', :from::timestamp),
                    DATE_TRUNC('day', :to::timestamp),
                    INTERVAL '1 day'
                ) AS date
            )
            SELECT
                ds.date,
                coalesce(tvd.count, 0) AS count
            FROM
                date_series ds
            LEFT JOIN
                transaction_volume_daily tvd ON ds.date = tvd.timestamp
            AND
                tvd."workspaceId" = :workspaceId
            ORDER BY
                ds.date ASC;
        `, {
            replacements: {
                from: new Date(earliestTimestamp),
                to,
                workspaceId: this.id
            }
        });

        return transactions;
    }

    async getDeployedContractCount(from, to) {
        if (!from || !to) throw new Error('Missing parameter');

        const [earliestBlock] = await this.getBlocks({
            attributes: ['timestamp'],
            where: {
                timestamp: { [Op.gt]: new Date(0) }
            },
            order: [['number', 'ASC']],
            limit: 1
        });

        if (!earliestBlock && +new Date(from) == 0)
            return [];

        const earliestTimestamp = +new Date(from) == 0 ? earliestBlock.timestamp : new Date(from);

        const [deployedContractCount,] = await sequelize.query(`
            SELECT
                time_bucket_gapfill('1 day', timestamp) AS date,
                coalesce(count(1), 0) AS count
            FROM transaction_events
            WHERE timestamp >= timestamp :from
                AND timestamp < timestamp :to
                AND "to" IS NULL
                AND "workspaceId" = :workspaceId
            GROUP BY date
            ORDER BY date ASC;
        `, {
            replacements: {
                from: new Date(earliestTimestamp),
                to,
                workspaceId: this.id
            }
        });

        return deployedContractCount;
    }

    async getCumulativeDeployedContractCount(from, to) {
        if (!from || !to) throw new Error('Missing parameter');

        const [earliestBlock] = await this.getBlocks({
            where: {
                timestamp: { [Op.gt]: new Date(0) }
            },
            attributes: ['timestamp'],
            order: [['number', 'ASC']],
            limit: 1
        });

        if (!earliestBlock && +new Date(from) == 0)
            return [];

        const earliestTimestamp = +new Date(from) == 0 ? earliestBlock.timestamp : new Date(from);

        const [cumulativeDeployedContractCount,] = await sequelize.query(`
            WITH days AS (
                SELECT
                    d::date as day
                FROM generate_series(:from::date, :to::date, interval  '1 day') d
            ),
            counts AS (
                SELECT
                    day::timestamptz AS counts_date,
                    count(1) AS count
                FROM transaction_events, days
                WHERE timestamp <= days.day + interval '1 day'
                    AND "to" IS NULL
                    AND "workspaceId" = :workspaceId
                GROUP BY day
                ORDER BY day ASC
            ),
            filled AS (
                SELECT
                    time_bucket_gapfill('1 day', counts_date) AS date,
                    locf(avg(count))
                FROM counts
                WHERE counts_date >= :from::date and counts_date < :to::date
                GROUP BY date
            )
            SELECT date, coalesce(locf, 0)::integer count FROM filled
        `, {
            replacements: {
                from: new Date(earliestTimestamp),
                to,
                workspaceId: this.id
            }
        });

        return cumulativeDeployedContractCount;
    }


    async getCumulativeWalletCount(from, to) {
        if (!from || !to) throw new Error('Missing parameter');

        const [earliestBlock] = await this.getBlocks({
            attributes: ['timestamp'],
            where: {
                timestamp: { [Op.gt]: new Date(0) }
            },
            order: [['number', 'ASC']],
            limit: 1
        });

        if (!earliestBlock && +new Date(from) == 0)
            return [];

        const earliestTimestamp = +new Date(from) == 0 ? earliestBlock.timestamp : new Date(from);

        const [cumulativeWalletCount,] = await sequelize.query(`
            WITH days AS (
                SELECT
                    d::date as day
                FROM generate_series(:from::date, :to::date, interval  '1 day') d
            ),
            counts AS (
                SELECT
                    day::timestamptz AS counts_date,
                    count(distinct "from")
                FROM transaction_events, days
                WHERE timestamp <= days.day + interval '1 day' AND "workspaceId" = :workspaceId
                GROUP BY day
                ORDER BY day ASC
            ),
            filled AS (
                SELECT
                    time_bucket_gapfill('1 day', counts_date) AS date,
                    locf(avg(count))
                FROM counts
                WHERE counts_date >= :from::date and counts_date < :to::date
                GROUP BY date
            )
            SELECT date, coalesce(locf, 0)::integer count FROM filled
        `, {
            replacements: {
                from: new Date(earliestTimestamp),
                to,
                workspaceId: this.id
            }
        });

        return cumulativeWalletCount;
    }

    async getUniqueWalletCount(from, to) {
        if (!from || !to) throw new Error('Missing parameter');

        const [earliestBlock] = await this.getBlocks({
            attributes: ['timestamp'],
            where: {
                timestamp: { [Op.gt]: new Date(0) }
            },
            order: [['number', 'ASC']],
            limit: 1
        });

        if (!earliestBlock && +new Date(from) == 0)
            return [];

        const earliestTimestamp = +new Date(from) == 0 ? earliestBlock.timestamp : new Date(from);

        const [uniqueWalletCount,] = await sequelize.query(`
            WITH date_series AS (
                SELECT generate_series(
                    DATE_TRUNC('day', :from::timestamp),
                    DATE_TRUNC('day', :to::timestamp),
                    INTERVAL '1 day'
                ) AS date
            )
            SELECT
                ds.date,
                coalesce(awd.count, 0) AS count
            FROM
                date_series ds
            LEFT JOIN
                active_wallets_daily awd ON ds.date = awd.timestamp
            AND
                awd."workspaceId" = :workspaceId
            ORDER BY
                ds.date ASC;
        `, {
            replacements: {
                from: new Date(earliestTimestamp),
                to,
                workspaceId: this.id
            }
        });

        return uniqueWalletCount;
    } 

    async getAverageGasPrice(from, to) {
        if (!from || !to) throw new Error('Missing parameter');

        const [earliestBlock] = await this.getBlocks({
            attributes: ['timestamp'],
            where: {
                timestamp: { [Op.gt]: new Date(0) }
            },
            order: [['number', 'ASC']],
            limit: 1
        });

        if (!earliestBlock && +new Date(from) == 0)
            return [];

        const earliestTimestamp = +new Date(from) == 0 ? earliestBlock.timestamp : new Date(from);

        const [avgGasPrice,] = await sequelize.query(`
            SELECT
                time_bucket_gapfill('1 day', timestamp) AS date,
                coalesce(round(avg("gasPrice")), 0) AS avg
            FROM transaction_events
            WHERE timestamp >= timestamp :from
                AND timestamp < timestamp :to
                AND "workspaceId" = :workspaceId
            GROUP BY date
            ORDER BY date ASC;
        `, {
            replacements: {
                from: new Date(earliestTimestamp),
                to,
                workspaceId: this.id
            }
        });

        return avgGasPrice;
    }

    async getAverageTransactionFee(from, to) {
        if (!from || !to) throw new Error('Missing parameter');

        const [earliestBlock] = await this.getBlocks({
            attributes: ['timestamp'],
            where: {
                timestamp: { [Op.gt]: new Date(0) }
            },
            order: [['number', 'ASC']],
            limit: 1
        });

        if (!earliestBlock && +new Date(from) == 0)
            return [];

        const earliestTimestamp = +new Date(from) == 0 ? earliestBlock.timestamp : new Date(from);

        const [avgTransactionFee,] = await sequelize.query(`
            SELECT
                time_bucket_gapfill('1 day', timestamp) AS date,
                coalesce(round(avg("transactionFee")), 0) AS avg
            FROM transaction_events
            WHERE timestamp >= timestamp :from
                AND timestamp < timestamp :to
                AND "workspaceId" = :workspaceId
            GROUP BY date
            ORDER BY date ASC;
        `, {
            replacements: {
                from: new Date(earliestTimestamp),
                to,
                workspaceId: this.id
            }
        });

        return avgTransactionFee;
    }

    async getTokenTransferVolume(from, to, token, type) {
        if (!from || !to) throw new Error('Missing parameter');

        const [earliestBlock] = await this.getBlocks({
            attributes: ['timestamp'],
            where: {
                timestamp: { [Op.gt]: new Date(0) }
            },
            order: [['number', 'ASC']],
            limit: 1
        });

        if (!earliestBlock && +new Date(from) == 0)
            return [];

        const earliestTimestamp = +new Date(from) == 0 ? earliestBlock.timestamp : new Date(from);

        let query = `
            SELECT
                time_bucket_gapfill('1 day', timestamp) AS date,
                coalesce(count(1), 0) AS count
            FROM token_transfer_events
            WHERE timestamp >= timestamp :from
                AND timestamp < timestamp :to
                AND "workspaceId" = :workspaceId`;

        if (token) {
            query += ` AND token = :token`;
        }

        if (type) {
            query += ` AND "tokenType" = :type`;
        }

        query += ` GROUP BY date
            ORDER BY date ASC;
        `;

        const [transfers,] = await sequelize.query(query, {
            replacements: {
                from: new Date(earliestTimestamp),
                to,
                workspaceId: this.id,
                token, type
            }
        });

        return transfers;
    }

    async countActiveWallets() {
        const [earliestBlock] = await this.getBlocks({
            attributes: ['timestamp'],
            where: {
                timestamp: { [Op.gt]: new Date(0) }
            },
            order: [['number', 'ASC']],
            limit: 1
        });
        const since = earliestBlock ? new Date(earliestBlock.timestamp) : new Date(0);

        const [{ count },] = await sequelize.query(`
            SELECT COUNT(*)
            FROM (
                SELECT "from"
                FROM transaction_events
                WHERE "workspaceId" = :workspaceId
                AND timestamp >= DATE_TRUNC('day', :since::timestamp)
                GROUP BY "from"
            ) wallets
        `, {
            type: QueryTypes.SELECT,
            replacements: {
                workspaceId: this.id,
                since
            }
        });
        return parseInt(count);
    }

    async safeFindLatestTokenBalances(address, tokenPatterns = []) {
        if (!address) return [];

        const allowedTokenPatterns = tokenPatterns.filter(p => ['erc20', 'erc721'].indexOf(p) > -1);

        let tokenFilter = {
            [Op.and]: sequelize.where(
                sequelize.col("tokenContract.workspaceId"),
                Op.eq,
                sequelize.col("TokenBalanceChange.workspaceId")
            ),
            [Op.and]: sequelize.where(
                sequelize.col("tokenContract.address"),
                Op.eq,
                sequelize.col("TokenBalanceChange.token")
            )
        };

        if (allowedTokenPatterns.length) {
            tokenFilter = { patterns: { [Op.contains]: allowedTokenPatterns }, ...tokenFilter };
        }

        const tokenBalanceChanges = await this.getTokenBalanceChanges({
            where: {
                address: address.toLowerCase()
            },
            order: [['token'], ['transaction', 'blockNumber', 'DESC']],
            include: [
                {
                    model: sequelize.models.Contract,
                    attributes: ['name', 'tokenName', 'tokenSymbol', 'tokenDecimals', 'address', 'workspaceId'],
                    as: 'tokenContract',
                    where: tokenFilter,
                    required: !!allowedTokenPatterns.length
                },
                {
                    model: sequelize.models.Transaction,
                    attributes: ['blockNumber'],
                    as: 'transaction'
                }
            ]
        });

        const result = {};
        tokenBalanceChanges.forEach(item => {
            if (!result[item.token] || result[item.token] && item.blockNumber > result[item.token].blockNumber)
                result[item.token] = item.toJSON();
        });

        return Object.values(result);
    }

    getFilteredAccounts(page = 1, itemsPerPage = 10, orderBy = 'address', order = 'DESC') {
        if (page == -1)
            return this.getAccounts({
                order: [[orderBy, order]],
                attributes: ['workspaceId', 'address', 'balance', 'privateKey']
            });
        else
            return this.getAccounts({
                offset: (page - 1) * itemsPerPage,
                limit: itemsPerPage,
                order: [[orderBy, order]],
                attributes: ['workspaceId', 'address', 'balance', 'privateKey']
            });
    }

    getFilteredContracts(page = 1, itemsPerPage = 10, orderBy = 'timestamp', order = 'DESC', pattern = null) {
        const allowedPattern = pattern && ['erc20', 'erc721'].indexOf(pattern.toLowerCase()) > -1 ? pattern : null;
        const where = allowedPattern ? { patterns: { [Op.contains]: [allowedPattern] } } : {};
        const sanitizedOrder = `${['ASC', 'DESC'].indexOf(order.toUpperCase()) > - 1 ? order : 'DESC'} NULLS LAST`;

        let sanitizedOrderBy;
        switch(orderBy) {
            case 'name':
            case 'address':
            case 'tokenName':
            case 'tokenSymbol':
                sanitizedOrderBy = [orderBy];
                break;
            case 'tokenTotalSupply':
                sanitizedOrderBy = [sequelize.cast(sequelize.col('"Contract"."tokenTotalSupply'), 'numeric')];
                break
            case 'timestamp':
            default:
                sanitizedOrderBy = ['creationTransaction', 'timestamp'];
                break;
        }

        return this.getContracts({
            where: where,
            offset: (page - 1) * itemsPerPage,
            limit: itemsPerPage,
            order: [[...sanitizedOrderBy, sanitizedOrder]],
            attributes: ['address', 'name', 'timestamp', 'patterns', 'workspaceId', 'tokenName', 'tokenSymbol', 'tokenTotalSupply'],
            include: [
                {
                    model: sequelize.models.ContractVerification,
                    as: 'verification',
                    attributes: ['createdAt']
                },
                {
                    model: sequelize.models.Transaction,
                    as: 'creationTransaction',
                    attributes: ['hash', 'timestamp', 'from']
                }
            ]
        });
    }

    getFilteredBlocks(page = 1, itemsPerPage = 10, order = 'DESC', orderBy = 'number') {
        return this.getBlocks({
            offset: (page - 1) * itemsPerPage,
            limit: itemsPerPage,
            order: [[orderBy, order]]
        });
    }

    countTransactionsSince(since = 0) {
        return this.countTransactions({
            where: {
                timestamp: { [Op.gte]: since }
            }
        });
    }

    getFilteredTransactions(page = 1, itemsPerPage = 10, order = 'DESC', orderBy = 'blockNumber', address) {
        const where = address ? { [Op.or]: [{ to: address.toLowerCase() }, { from: address.toLowerCase() }] } : {};
        return this.getTransactions({
            where: where,
            offset: (page - 1) * itemsPerPage,
            limit: itemsPerPage,
            order: [[orderBy, order]],
            attributes: ['blockNumber', 'from', 'gasPrice', 'hash', 'methodDetails', 'data', 'timestamp', 'to', 'value', 'workspaceId', 'state'],
            include: [
                {
                    model: sequelize.models.TransactionReceipt,
                    attributes: ['gasUsed', 'status', 'contractAddress', [sequelize.json('raw.root'), 'root'], 'gasUsed', 'cumulativeGasUsed', [sequelize.json('raw.effectiveGasPrice'), 'effectiveGasPrice']],
                    as: 'receipt'
                },
                {
                    model: sequelize.models.Contract,
                    attributes: ['abi', 'name', 'tokenName', 'tokenSymbol'],
                    as: 'contract',
                    include: {
                        model: sequelize.models.ContractVerification,
                        attributes: ['createdAt'],
                        as: 'verification'
                    }
                }
            ]
        });
    }

    async canCreateContract() {
        if (this.public)
            return true;

        const user = await this.getUser();
        if (user.isPremium)
            return true;

        const contractCount = await this.countContracts();
        return contractCount < 10;
    }

    async safeCreatePartialBlock(block) {
        return sequelize.transaction(async sequelizeTransaction => {
            try {
                const transactions = block.transactions.map(transaction => {
                    const processed = processRawRpcObject(
                        transaction,
                        Object.keys(sequelize.models.Transaction.rawAttributes),
                        ['input', 'index']
                    );

                    return sanitize({
                        workspaceId: this.id,
                        blockHash: processed.blockHash,
                        blockNumber: processed.blockNumber,
                        creates: processed.creates,
                        data: transaction.data || transaction.input,
                        parsedError: processed.parsedError,
                        rawError: processed.rawError,
                        from: processed.from,
                        gasLimit: processed.gasLimit || block.gasLimit,
                        gasPrice: processed.gasPrice,
                        hash: processed.hash,
                        methodLabel: processed.methodLabel,
                        methodName: processed.methodName,
                        methodSignature: processed.methodSignature,
                        nonce: processed.nonce,
                        r: processed.r,
                        s: processed.s,
                        timestamp: block.timestamp,
                        to: processed.to,
                        transactionIndex: transaction.transactionIndex !== undefined && transaction.transactionIndex !== null ? transaction.transactionIndex : transaction.index,
                        type_: processed.type,
                        v: processed.v,
                        value: processed.value,
                        state: 'syncing',
                        raw: processed.raw
                    });
                });

                const [createdBlock] = await sequelize.models.Block.bulkCreate(
                    [
                        sanitize({
                            workspaceId: this.id,
                            baseFeePerGas: block.baseFeePerGas,
                            difficulty: block.difficulty,
                            extraData: block.extraData,
                            gasLimit: block.gasLimit,
                            gasUsed: block.gasUsed,
                            hash: block.hash,
                            miner: block.miner,
                            nonce: block.nonce,
                            number: block.number,
                            parentHash: block.parentHash,
                            timestamp: block.timestamp,
                            transactionsCount: block.transactions ? block.transactions.length : 0,
                            state: 'ready',
                            l1BlockNumber: block.l1BlockNumber,
                            raw: block.raw,
                        })
                    ],
                    {
                        ignoreDuplicates: true,
                        individualHooks: true,
                        returning: true,
                        transaction: sequelizeTransaction
                    }
                );

                const transactionsToInsert = transactions.map(t => {
                    return {
                        ...t,
                        blockId: createdBlock.id
                    }
                });

                const storedTransactions = await sequelize.models.Transaction.bulkCreate(transactionsToInsert, {
                    ignoreDuplicates: true,
                    returning: true,
                    individualHooks: true,
                    transaction: sequelizeTransaction
                });

                return { ...createdBlock, transactions: storedTransactions };
            } catch(error) {
                const blockAlreadyExists = error.errors && error.errors.find(e => e.validatorKey === 'not_unique');
                if (blockAlreadyExists)
                    return null;
                else
                    throw error;
            }
        });
    }

    /*
        It's all or nothing, we make sure we synchronize all the block info, ie:
        - Block
        - Transactions
        - Receipt
        - Logs
        It takes longer, but we avoid inconsistencies, such as a block not displaying all transactions
    */
    async safeCreateFullBlock(data) {
        try {
            return await sequelize.transaction(async sequelizeTransaction => {
                const block = data.block;
                const transactions = data.transactions;

                if (block.transactions.length != transactions.length)
                    throw new Error('Missing transactions in block.');

                const [, [storedBlock]] = await sequelize.models.Block.update(
                    { state: 'ready' },
                    {
                        where: {
                            workspaceId: this.id,
                            number: block.number
                        },
                        individualHooks: true,
                        returning: true,
                        transaction: sequelizeTransaction
                    }
                );

                for (let i = 0; i < transactions.length; i++) {
                    const transaction = transactions[i];
                    const [, [storedTx]] = await sequelize.models.Transaction.update(
                        { state: 'ready' },
                        {
                            where: {
                                workspaceId: this.id,
                                hash: transaction.hash
                            },
                            individualHooks: true,
                            returning: true,
                            transaction: sequelizeTransaction
                        }
                    );

                    const receipt = transaction.receipt;
                    if (!receipt)
                        throw new Error('Missing transaction receipt.');

                    const storedReceipt = await storedTx.createReceipt(sanitize({
                        workspaceId: storedTx.workspaceId,
                        blockHash: receipt.blockHash,
                        blockNumber: receipt.blockNumber,
                        byzantium: receipt.byzantium,
                        confirmations: receipt.confirmations,
                        contractAddress: receipt.contractAddress,
                        cumulativeGasUsed: receipt.cumulativeGasUsed,
                        from: receipt.from,
                        gasUsed: receipt.gasUsed,
                        logsBloom: receipt.logsBloom,
                        status: receipt.status,
                        to: receipt.to,
                        transactionHash: receipt.transactionHash || receipt.hash || storedTx.hash,
                        transactionIndex: receipt.transactionIndex || receipt.index,
                        type: receipt.type,
                        raw: receipt
                    }), { transaction: sequelizeTransaction });

                    for (let i = 0; i < receipt.logs.length; i++) {
                        const log = receipt.logs[i];
                        try {
                            await storedReceipt.createLog(sanitize({
                                workspaceId: storedTx.workspaceId,
                                address: log.address,
                                blockHash: log.blockHash,
                                blockNumber: log.blockNumber,
                                data: log.data,
                                logIndex: log.logIndex,
                                topics: log.topics,
                                transactionHash: log.transactionHash,
                                transactionIndex: log.transactionIndex,
                                raw: log
                            }), { transaction: sequelizeTransaction });
                        } catch(error) {
                            logger.error(error.message, { location: 'models.workspaces.safeCreateFullBlock', error: error, data });
                            await storedReceipt.createLog(sanitize({
                                workspaceId: storedTx.workspaceId,
                                raw: log
                            }), { transaction: sequelizeTransaction });
                        }
                    }

                    const explorer = await this.getExplorer();
                    if (explorer) {
                        const stripeSubscription = await explorer.getStripeSubscription();
                        if (stripeSubscription)
                            await stripeSubscription.increment('transactionQuota', { transaction: sequelizeTransaction });
                    }
                }

                return storedBlock;
            });
        } catch(error) {
            await this.safeDestroyPartialBlock(data.block.number);
            throw error;
        }
    }

    async safeDestroyPartialBlock(blockNumber) {
        const [block] = await this.getBlocks({ where: { workspaceId: this.id, number: blockNumber }});

        // No need to throw an error if the block we are trying to destroy does not exist or is not partial
        if (!block || block.state !== 'syncing') return;

        return block.revertIfPartial();
    }

    safeCreateBlock(block) {
        return this.createBlock(sanitize({
            baseFeePerGas: block.baseFeePerGas,
            difficulty: block.difficulty,
            extraData: block.extraData,
            gasLimit: block.gasLimit,
            gasUsed: block.gasUsed,
            hash: block.hash,
            miner: block.miner,
            nonce: block.nonce,
            number: block.number,
            parentHash: block.parentHash,
            timestamp: block.timestamp,
            transactionsCount: block.transactions ? block.transactions.length : 0,
            raw: block
        }));
    }

    async safeCreateTransaction(transaction, blockId) {
        return sequelize.transaction(async (sequelizeTransaction) => {
            const storedTx = await this.createTransaction(sanitize({
                blockHash: transaction.blockHash,
                blockNumber: transaction.blockNumber,
                blockId: blockId,
                creates: transaction.creates,
                data: transaction.data,
                parsedError: transaction.parsedError,
                rawError: transaction.rawError,
                from: transaction.from,
                gasLimit: transaction.gasLimit,
                gasPrice: transaction.gasPrice,
                hash: transaction.hash,
                methodLabel: transaction.methodLabel,
                methodName: transaction.methodName,
                methodSignature: transaction.methodSignature,
                nonce: transaction.nonce,
                r: transaction.r,
                s: transaction.s,
                timestamp: transaction.timestamp,
                to: transaction.to,
                transactionIndex: transaction.transactionIndex !== undefined && transaction.transactionIndex !== null ? transaction.transactionIndex : transaction.index,
                type_: transaction.type,
                v: transaction.v,
                value: transaction.value,
                raw: transaction
            }), { transaction: sequelizeTransaction });

            const receipt = transaction.receipt;
            if (receipt) {
                const storedReceipt = await storedTx.createReceipt(sanitize({
                    workspaceId: storedTx.workspaceId,
                    blockHash: receipt.blockHash,
                    blockNumber: receipt.blockNumber,
                    byzantium: receipt.byzantium,
                    confirmations: receipt.confirmations,
                    contractAddress: receipt.contractAddress,
                    cumulativeGasUsed: receipt.cumulativeGasUsed,
                    from: receipt.from,
                    gasUsed: receipt.gasUsed,
                    logsBloom: receipt.logsBloom,
                    status: receipt.status,
                    to: receipt.to,
                    transactionHash: receipt.transactionHash || receipt.hash || storedTx.hash,
                    transactionIndex: receipt.transactionIndex !== undefined && receipt.transactionIndex !== null ? receipt.transactionIndex : receipt.index,
                    type_: receipt.type,
                    raw: receipt
                }), { transaction: sequelizeTransaction });

                for (let i = 0; i < receipt.logs.length; i++) {
                    const log = receipt.logs[i];
                    try {
                        await storedReceipt.createLog(sanitize({
                            workspaceId: storedTx.workspaceId,
                            address: log.address,
                            blockHash: log.blockHash,
                            blockNumber: log.blockNumber,
                            data: log.data,
                            logIndex: log.logIndex,
                            topics: log.topics,
                            transactionHash: log.transactionHash,
                            transactionIndex: log.transactionIndex,
                            raw: log
                        }), { transaction: sequelizeTransaction });
                    } catch(error) {
                        logger.error(error.message, { location: 'models.workspaces.safeCreateTransaction', error: error, transaction: transaction });
                        await storedReceipt.createLog(sanitize({
                            workspaceId: storedTx.workspaceId,
                            raw: log
                        }), { transaction: sequelizeTransaction });
                    }
                }
            }

            return storedTx;
        });
    }

    async safeCreateOrUpdateContract(contract, transaction) {
        const contracts = await this.getContracts({ where: { address: contract.address.toLowerCase() }});
        const existingContract = contracts[0];

        const newContract = sanitize({
            hashedBytecode: contract.hashedBytecode,
            abi: contract.abi,
            address: contract.address,
            name: contract.name,
            imported: contract.imported,
            patterns: contract.patterns,
            processed: contract.processed,
            proxy: contract.proxy,
            timestamp: contract.timestamp,
            tokenDecimals: contract.tokenDecimals,
            tokenName: contract.tokenName,
            tokenSymbol: contract.tokenSymbol,
            tokenTotalSupply: contract.tokenTotalSupply,
            watchedPaths: contract.watchedPaths,
            has721Metadata: contract.has721Metadata,
            has721Enumerable: contract.has721Enumerable,
            ast: contract.ast,
            bytecode: contract.bytecode,
            asm: contract.asm,
            transactionId: contract.transactionId
        });

        if (existingContract)
            return existingContract.update(newContract, { transaction })
        else
            return this.createContract(newContract, { transaction });
    }

    async safeCreateOrUpdateAccount(account) {
        const accounts = await this.getAccounts({ where: { address: account.address.toLowerCase() }});
        const existingAccount = accounts[0];
        const newAccount = sanitize({
            address: account.address,
            balance: account.balance,
            privateKey: account.privateKey
        });

        if (existingAccount)
            return existingAccount.update(newAccount);
        else
            return this.createAccount(newAccount);
    }

    findContractsByText(text) {
        return this.getContracts({
            attributes: ['id', 'address', 'name', 'tokenName', 'tokenSymbol', 'patterns'],
            where: {
                [Op.or]: [
                    { name: { [Op.iLike]: `%${text}%` } },
                    { tokenName: { [Op.iLike]: `%${text}%` } },
                    { tokenSymbol: { [Op.iLike]: `%${text}%` } },
                ]
            },
            include: {
                model: sequelize.models.ContractVerification,
                as: 'verification',
                attributes: ['createdAt']
            }
        })
    }

    async findBlockByHash(hash) {
        const blocks = await this.getBlocks({
            where: {
                hash: hash
            }
        });

        return blocks.length ? blocks[0] : null;
    }

    getTransactionLogs(hash, page = 1, itemsPerPage = 20) {
        if (!hash)
            throw new Error('Missing parameter');

        return sequelize.models.TransactionLog.findAndCountAll({
            where: {
                workspaceId: this.id,
                '$receipt.transactionHash$': hash
            },
            include: {
                model: sequelize.models.TransactionReceipt,
                as: 'receipt',
                attributes: ['transactionHash']
            },
            offset: (page - 1) * itemsPerPage,
            limit: itemsPerPage,
            attributes: ['id', 'address', 'data', 'logIndex', 'topics']
        })
    }

    async findTransaction(hash) {
        const blockAttributes = ['gasLimit', 'timestamp'];
        const explorer = await this.getExplorer({
            include: {
                model: sequelize.models.StripeSubscription,
                as: 'stripeSubscription',
                include: 'stripePlan'
            }
        });

        if (explorer && await explorer.canUseCapability('l1Explorer')) {
            blockAttributes.push('l1BlockNumber')
        };

        const transactions = await this.getTransactions({
            where: {
                hash: hash
            },
            attributes: ['id', 'blockNumber', 'data', 'parsedError', 'rawError', 'from', 'formattedBalanceChanges', 'gasLimit', 'gasPrice', 'hash', 'timestamp', 'to', 'value', 'storage', 'workspaceId', 'raw', 'state',
                [Sequelize.literal(`
                    (SELECT COUNT(*)::int
                    FROM token_transfers AS token_transfers
                    WHERE token_transfers."transactionId" = "Transaction".id)
                `), 'tokenTransferCount']
            ],
            order: [
                [sequelize.literal('"traceSteps".'), 'id', 'asc']
            ],
            include: [
                {
                    model: sequelize.models.TransactionReceipt,
                    attributes: ['gasUsed', 'status', 'contractAddress', [sequelize.json('raw.root'), 'root'], 'cumulativeGasUsed', 'raw', [sequelize.json('raw.effectiveGasPrice'), 'effectiveGasPrice']],
                    as: 'receipt'
                },
                {
                    model: sequelize.models.TransactionTraceStep,
                    attributes: ['address', 'contractHashedBytecode', 'depth', 'input', 'op', 'returnData', 'workspaceId', 'id', 'value'],
                    as: 'traceSteps',
                    include: [
                        {
                            model: sequelize.models.Contract,
                            attributes: ['abi', 'address' , 'name', 'tokenDecimals', 'tokenName', 'tokenSymbol', 'workspaceId'],
                            include: [
                                {
                                    model: sequelize.models.Contract,
                                    attributes: ['name', 'tokenName', 'tokenSymbol', 'tokenDecimals', 'abi', 'address', 'workspaceId'],
                                    as: 'proxyContract',
                                    where: {
                                        [Op.and]: sequelize.where(
                                            sequelize.col("traceSteps->contract.workspaceId"),
                                            Op.eq,
                                            sequelize.col("traceSteps->contract->proxyContract.workspaceId")
                                        ),
                                    },
                                    required: false
                                },
                                {
                                    model: sequelize.models.ContractVerification,
                                    attributes: ['createdAt'],
                                    as: 'verification'
                                }
                            ],
                            as: 'contract'
                        }
                    ]
                },
                {
                    model: sequelize.models.TokenBalanceChange,
                    attributes: ['token', 'address', 'currentBalance', 'previousBalance', 'diff', 'transactionId'],
                    as: 'tokenBalanceChanges'
                },
                {
                    model: sequelize.models.Block,
                    attributes: blockAttributes,
                    as: 'block'
                },
                {
                    model: sequelize.models.Contract,
                    attributes: ['abi', 'address', 'name', 'tokenDecimals', 'tokenName', 'tokenSymbol', 'workspaceId'],
                    as: 'contract'
                }
            ]
        });

        return transactions.length ? transactions[0] : null;
    }

    async findBlockByNumber(number, withTransactions = false) {
        const include = withTransactions ? [{
            model: sequelize.models.Transaction,
            attributes: ['id', 'from', 'to', 'hash'],
            as: 'transactions'
        }] : [];
        const blocks = await this.getBlocks({
            where: {
                number: number
            },
            include: include
        });
        return blocks[0];
    }

    async findContractById(contractId) {
        const contracts = await this.getContracts({
            where: {
                id: contractId
            }
        });
        return contracts[0];
    }

    async findContractByAddress(address) {
        const contracts = await this.getContracts({
            where: {
                address: address.toLowerCase()
            },
            include: [
                {
                    model: sequelize.models.Contract,
                    attributes: ['name', 'tokenName', 'tokenSymbol', 'tokenDecimals', 'abi', 'address'],
                    as: 'proxyContract',
                    required: false,
                    where: {
                        [Op.and]: sequelize.where(
                            sequelize.col("Contract.workspaceId"),
                            Op.eq,
                            sequelize.col("proxyContract.workspaceId")
                        )
                    }
                },
                {
                    model: sequelize.models.ContractVerification,
                    as: 'verification',
                    include: [
                        {
                            model: sequelize.models.ContractSource,
                            as: 'sources'
                        }
                    ]
                },
                {
                    model: sequelize.models.Transaction,
                    as: 'creationTransaction',
                    attributes: ['hash', 'timestamp', 'from']
                }
            ]
        });

        return contracts[0];
    }

    async findContractByHashedBytecode(hashedBytecode) {
        const contracts = await this.getContracts({
            where: {
                hashedBytecode: hashedBytecode
            }
        });
        return contracts[0];
    }

    addIntegration(integration) {
        if (!INTEGRATION_FIELD_MAPPING[integration])
            throw '[workspace.addIntegration] Unknown integration';

        return this.update({
            [INTEGRATION_FIELD_MAPPING[integration]]: true
        });
    }

    removeIntegration(integration) {
        if (!INTEGRATION_FIELD_MAPPING[integration])
            throw '[workspace.removeIntegration] Unknown integration';

        return this.update({
            [INTEGRATION_FIELD_MAPPING[integration]]: false
        });
    }

    async updateSettings(data) {
        if (data.name) {
            const existing = await sequelize.models.Workspace.findOne({
                where: {
                    userId: this.userId,
                    name: data.name,
                    id: {
                        [Op.not]: this.id
                    }
                }
            });
            if (existing)
                throw new Error('You already have a workspace with this name.');
        }

        return sequelize.transaction(async (transaction) => {
            if (data.rpcServer && data.networkId) {
                const explorer = await this.getExplorer();
                if (explorer)
                    await explorer.update({ rpcServer: data.rpcServer, chainId: data.networkId }, { transaction });
            }
            return this.update(sanitize({
                name: data.name,
                statusPageEnabled: data.statusPageEnabled,
                chain: data.chain,
                rpcServer: data.rpcServer,
                networkId: data.networkId,
                tracing: data.advancedOptions && data.advancedOptions.tracing,
                defaultAccount: data.settings && data.settings.defaultAccount,
                gasLimit: data.settings && data.settings.gasLimit,
                gasPrice: data.settings && data.settings.gasPrice
            }), { transaction });
        });
    }

    safeDestroyBlocks(ids) {
        return sequelize.transaction(async transaction => {
            const blocks = await this.getBlocks({ where: { id: ids }});
            for (let i = 0; i < blocks.length; i++)
                await blocks[i].safeDestroy(transaction);
            return;
        });
    }

    safeDestroyContracts(ids) {
        return sequelize.transaction(async transaction => {
            const contracts = await this.getContracts({ where: { id: ids }});
            for (let i = 0; i < contracts.length; i++)
                await contracts[i].safeDestroy(transaction);
            return;
        });
    }

    async safeDestroyIntegrityCheck(transaction) {
        const integrityCheck = await this.getIntegrityCheck();
        if (integrityCheck)
            await integrityCheck.destroy(transaction);

        return this.update({ integrityCheckStartBlockNumber: null }, { transaction });
    }

    async safeDestroyRpcHealthCheck(transaction) {
        const rpcHealthCheck = await this.getRpcHealthCheck();
        if (rpcHealthCheck)
            return rpcHealthCheck.destroy({ transaction });
    }

    async safeDestroyAccounts() {
        return sequelize.transaction(async transaction => {
            const accounts = await sequelize.models.Account.findAll();
            for (let i = 0; i < accounts.length; i++)
                await accounts[i].destroy({ transaction });
        });
    }

    async reset(dayInterval, transaction) {
        const filter = { where: { workspaceId: this.id }};
        if (dayInterval)
            filter['where']['createdAt'] = { [Op.lt]: sequelize.literal(`NOW() - interval '${dayInterval} day'`)};

        const destroyAll = async transaction => {
            await this.safeDestroyIntegrityCheck(transaction);
            await this.safeDestroyRpcHealthCheck(transaction);

            const contracts = await sequelize.models.Contract.findAll(filter);
            for (let i = 0; i < contracts.length; i++)
                await contracts[i].safeDestroy(transaction);

            const blocks = await sequelize.models.Block.findAll(filter);
            for (let i = 0; i < blocks.length; i++)
                await blocks[i].safeDestroy(transaction);

            const accounts = await sequelize.models.Account.findAll(filter);
            for (let i = 0; i < accounts.length; i++)
                await accounts[i].destroy({ transaction });

        };

        return transaction ?
            destroyAll(transaction) :
            sequelize.transaction({ deferrable: Sequelize.Deferrable.SET_DEFERRED }, destroyAll);
    }

    async removeContractByAddress(address) {
        const contracts = await this.getContracts({ where: { address: address.toLowerCase() }});
        if (contracts.length)
            return contracts[0].destroy();
    }

    getUnprocessedContracts() {
        return this.getContracts({
            attributes: ['address', 'abi'],
            where: {
                processed: false
            }
        });
    }

    getFailedProcessableTransactions() {
        return this.getTransactions({
            attributes: ['hash', 'workspaceId', 'rawError', 'parsedError', 'to', 'data', 'blockNumber'],
            where: {
                [Op.and]: [
                    { parsedError: null },
                    { rawError: null },
                    { '$receipt.status$': false }
                ]
            },
            include: [
                {
                    model: sequelize.models.Workspace,
                    as: 'workspace',
                    attributes: ['id', 'public']
                },
                {
                    model: sequelize.models.TransactionReceipt,
                    attributes: ['status'],
                    as: 'receipt'
                }
            ]
        });
    }

    getProcessableTransactions() {
        const tokenTransferCount = `(
            SELECT COUNT(*)
            FROM "token_transfers"
            WHERE
                "token_transfers"."transactionId" = "Transaction"."id"
        )`;
        const tokenBalanceChangeCount = `(
            SELECT COUNT(*)
            FROM "token_balance_changes"
            WHERE
                "token_balance_changes"."transactionId" = "Transaction"."id"
        )`;

        return this.getTransactions({
            attributes: ['blockNumber', 'hash'],
            include: [
                {
                    model: sequelize.models.TokenTransfer,
                    attributes: ['id', 'src', 'dst', 'token'],
                    as: 'tokenTransfers'
                },
            ],
            where: {
                [Op.and]: [
                    sequelize.where(
                        sequelize.literal(tokenTransferCount), { [Op.gt]: 0 }
                    ),
                    sequelize.where(
                        sequelize.literal(tokenBalanceChangeCount), { [Op.eq]: 0 }
                    )
                ]
            },
        })
    }

    async safeCreateExplorer(transaction) {
        const creationFn = async transaction => {
            await this.update({
                storageEnabled: false,
                public: true,
                browserSyncEnabled: false,
                rpcHealthCheckEnabled: true,
                rateLimitInterval: 5000,
                rateLimitMaxInInterval: 25
            }, { transaction });

            const existingExplorer = await sequelize.models.Explorer.findOne({ where: { slug: slugify(this.name) }});
            const slug = existingExplorer ?
                `${slugify(this.name)}-${Math.floor(Math.random() * 100)}` :
                slugify(this.name);

            return this.createExplorer({
                userId: this.userId,
                chainId: this.networkId,
                name: this.name,
                rpcServer: this.rpcServer,
                slug: slug,
                themes: { "default": {}},
                domain: `${slug}.${process.env.APP_DOMAIN}`
            }, { transaction });
        }
        return transaction ? creationFn(transaction) : sequelize.transaction(creationFn);
    }
  }

  Workspace.init({
    name: DataTypes.STRING,
    chain: DataTypes.STRING,
    networkId: DataTypes.STRING,
    public: DataTypes.BOOLEAN,
    rpcServer: DataTypes.STRING,
    defaultAccount: DataTypes.STRING,
    gasLimit: DataTypes.STRING,
    gasPrice: DataTypes.STRING,
    userId: DataTypes.INTEGER,
    tracing: DataTypes.STRING,
    alchemyIntegrationEnabled: DataTypes.BOOLEAN,
    isRemote: DataTypes.BOOLEAN,
    dataRetentionLimit: DataTypes.INTEGER,
    storageEnabled: DataTypes.BOOLEAN,
    erc721LoadingEnabled: DataTypes.BOOLEAN,
    browserSyncEnabled: DataTypes.BOOLEAN,
    rpcHealthCheckEnabled: DataTypes.BOOLEAN,
    statusPageEnabled: DataTypes.BOOLEAN,
    pendingDeletion: DataTypes.BOOLEAN,
    pollingInterval: DataTypes.INTEGER,
    emitMissedBlocks: DataTypes.BOOLEAN,
    skipFirstBlock: DataTypes.BOOLEAN,
    qnEndpointId: DataTypes.STRING,
    integrityCheckStartBlockNumber: {
        type: DataTypes.INTEGER,
        get() {
            const blockNumber = this.getDataValue('integrityCheckStartBlockNumber');
            return blockNumber !== null && blockNumber !== undefined ?
                Math.max(this.getDataValue('integrityCheckStartBlockNumber'), 0) :
                null;
        }
    },
    rateLimitInterval: DataTypes.INTEGER,
    rateLimitMaxInInterval: DataTypes.INTEGER
  }, {
    hooks: {
        afterCreate(workspace, options) {
            const afterCreateFn = () => {
                const analytics = new Analytics();
                analytics.track(workspace.userId, 'workspace:workspace_create');
                analytics.shutdown();
            }
            return options.transaction ? options.transaction.afterCommit(afterCreateFn) : afterCreateFn();
        }
    },
    sequelize,
    modelName: 'Workspace',
    tableName: 'workspaces'
  });
  return Workspace;
};