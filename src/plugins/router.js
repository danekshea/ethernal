import VueRouter from 'vue-router';
import Blocks from '../components/Blocks.vue';
import Block from '../components/Block.vue';
import Transactions from '../components/Transactions.vue';
import Accounts from '../components/Accounts.vue';
import Transaction from '../components/Transaction.vue';
import Address from '../components/Address.vue';
import Auth from '../components/Auth.vue';
import Contracts from '../components/Contracts.vue';
import Tokens from '../components/Tokens.vue';
import Settings from '../components/Settings.vue';
import Overview from '../components/Overview.vue';
import ERC721Token from '../components/ERC721Token.vue';
import ERC721Collections from '../components/ERC721Collections.vue';
import ERC721Collection from '../components/ERC721Collection.vue';
import ERC20Contract from '../components/ERC20Contract.vue';
import ExplorerStatus from '../components/ExplorerStatus.vue';
import Explorers from '../components/Explorers.vue';
import Explorer from '../components/Explorer.vue';
import ExplorerAnalytics from '../components/ExplorerAnalytics.vue';
import ExplorerFaucet from '../components/ExplorerFaucet.vue';
import ExplorerDex from '../components/ExplorerDex.vue';

const auth = () => {
    return { currentUser: router.app.$store.getters.user };
}

const redirectIfLoggedIn = function (to, from, next) {
    if (auth().currentUser.id) {
        next(to || { path: '/transactions' });
    }
    else next();
};

const redirectIfLoggedOut = function (to, from, next) {
    if (to.hash && to.hash.startsWith('#'))
        to.query.tab = to.hash.split('#')[1];

    next();
};

const routes = [
    { path: '/auth', component: Auth, beforeEnter: redirectIfLoggedIn },
    { path: '/blocks', component: Blocks, beforeEnter: redirectIfLoggedOut },
    { path: '/overview', component: Overview, beforeEnter: redirectIfLoggedOut },
    { path: '/block/:number', component: Block, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/transactions', component: Transactions, beforeEnter: redirectIfLoggedOut },
    { path: '/accounts', component: Accounts, beforeEnter: redirectIfLoggedOut },
    { path: '/transaction/:hash', component: Transaction, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/tx/:hash', component: Transaction, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/address/:address', component: Address, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/address/:hash/:tokenId', component: ERC721Token, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/token/:hash/:tokenId', component: ERC721Token, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/token/:address', component: ERC20Contract, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/contract/:address', redirect: '/address/:address' },
    { path: '/contracts', component: Contracts, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/tokens', component: Tokens, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/nfts', component: ERC721Collections, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/nft/:address', component: ERC721Collection, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/settings', component: Settings, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/analytics', component: ExplorerAnalytics, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/explorers', component: Explorers, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/explorers/:id', component: Explorer, props: true, beforeEnter: redirectIfLoggedOut },
    { path: '/status', component: ExplorerStatus, beforeEnter: redirectIfLoggedOut },
    { path: '/faucet', component: ExplorerFaucet, beforeEnter: redirectIfLoggedOut },
    { path: '/dex', component: ExplorerDex, beforeEnter: redirectIfLoggedOut },
    { path: '*', redirect: '/overview' }
];

const router = new VueRouter({
    mode: 'history',
    routes: routes
});

export default router;
