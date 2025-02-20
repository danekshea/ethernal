<template>
    <v-container fluid v-if="!loading">
        <template v-if="block">
            <v-row>
                <v-col cols="6">
                    <v-alert dense text type="warning" class="my-2" v-show="syncing">
                        Some transactions in this block are still being processed ({{ block.syncedTransactionCount }} / {{ block.transactionsCount }}).
                    </v-alert>
                    <h2>Block {{ block.number && commify(block.number) }}</h2>
                </v-col>
            </v-row>
            <v-row class="mb-4">
                <v-col lg="2" md="12" sm="12">
                    <v-subheader class="text-overline">Gas Limit</v-subheader>
                    {{ parseInt(block.gasLimit).toLocaleString() }}
                </v-col>
                <v-divider vertical></v-divider>
                <v-col lg="2" md="12" sm="12">
                    <v-subheader class="text-overline">Mined On</v-subheader>
                    {{ moment(block.timestamp) | moment('MM/DD h:mm:ss A') }}<br>
                    <small>{{ moment(block.timestamp).fromNow() }}</small>
                </v-col>
                <v-divider vertical></v-divider>
                <v-col lg="4" md="12" sm="12">
                    <v-subheader class="text-overline">Hash</v-subheader>
                    <span style="overflow-wrap: break-word;">{{ block.hash }}</span>
                </v-col>
                <template v-if="publicExplorer && publicExplorer.l1Explorer && block.l1BlockNumber">
                    <v-divider vertical></v-divider>
                    <v-col lg="2" md="12" sm="12">
                        <v-subheader class="text-overline">L1 Block</v-subheader>
                        <a :href="`${publicExplorer.l1Explorer}/block/${block.l1BlockNumber}`" target="_blank">{{ commify(block.l1BlockNumber) }}</a>
                    </v-col>
                </template>
            </v-row>
            <h4>Transactions</h4>
            <v-card outlined>
                <Transactions-List @listUpdated="listUpdated(number)" :blockNumber="number" :withCount="true" />
            </v-card>
        </template>
        <template v-else>
            <v-card outlined>
                <v-card-text>
                    <v-row>
                        <v-col align="center">
                            <v-icon style="opacity: 0.25;" size="200" color="primary lighten-1">mdi-cube-outline</v-icon>
                        </v-col>
                    </v-row>
                    <v-row>
                        <v-col class="text-body-1 text-center">
                            This block has not been mined. Current block: <router-link style="text-decoration: none;" :to="'/block/' + currentBlock.number">{{ currentBlock.number && commify(currentBlock.number) }}</router-link>
                        </v-col>
                    </v-row>
                </v-card-text>
            </v-card>
        </template>
    </v-container>
    <v-container fluid v-else>
        <v-card outlined>
            <v-card-text>
                <v-row>
                    <v-col cols="2"><v-skeleton-loader type="list-item-three-line"></v-skeleton-loader></v-col>
                    <v-col cols="2"><v-skeleton-loader type="list-item-three-line"></v-skeleton-loader></v-col>
                    <v-col cols="2"><v-skeleton-loader type="list-item-three-line"></v-skeleton-loader></v-col>
                </v-row>
                <v-row>
                    <v-col>
                        <v-skeleton-loader max-height="40vh" type="table"></v-skeleton-loader>
                    </v-col>
                </v-row>
            </v-card-text>
        </v-card>
    </v-container>
</template>

<script>
const moment = require('moment');
const ethers = require('ethers');
import { mapGetters } from 'vuex';
import TransactionsList from './TransactionsList';

export default {
    name: 'Block',
    props: ['number'],
    components: {
        TransactionsList
    },
    data: () => ({
        block: null,
        pusherChannelHandler: null,
        loading: true
    }),
    mounted() {
        this.pusherChannelHandler = this.pusher.onNewBlock(data => {
            if (data.number == this.number)
                this.loadBlock(this.number);
        }, this);
    },
    destroy() {
        this.pusherChannelHandler.unbind(null, null, this);
    },
    methods: {
        moment,
        commify: ethers.utils.commify,
        loadBlock(number) {
            this.loading = true;
            this.server.getBlock(number)
                .then(({ data }) => this.block = data)
                .catch(console.log)
                .finally(() => this.loading = false);
        },
        listUpdated(number) {
            this.server.getBlock(number)
                .then(({ data }) => this.block = data)
                .catch(console.log);
        }
    },
    computed: {
        ...mapGetters([
            'publicExplorer',
            'currentBlock'
        ]),
        syncing() {
            return this.block && this.block.syncedTransactionCount < this.block.transactionsCount;
        }
    },
    watch: {
        number: {
            immediate: true,
            handler(number) { this.loadBlock(number); }
        }
    }
}
</script>
