// tslint:disable:no-unnecessary-type-assertion
import { DecodedLogEvent, ExchangeEvents, LogFillContractEventArgs, ZeroEx } from '0x.js';
import { HttpClient } from '@0xproject/connect';
import { getOrderHashHex } from '@0xproject/order-utils';
import {
BlockParamLiteral,
DoneCallback,
OrderState,
OrderStateInvalid,
OrderStateValid,
SignedOrder,
} from '@0xproject/types';
import { BigNumber, logUtils } from '@0xproject/utils';
import { Web3Wrapper } from '@0xproject/web3-wrapper';
import * as _ from 'lodash';
import Web3ProviderEngine = require('web3-provider-engine');
import RPCSubprovider = require('web3-provider-engine/subproviders/rpc');

import { OrderWatcher } from '../node_modules/@0xproject/order-watcher';
const FIREBASE_CFG = { 'databaseURL': 'https://dextroid-b1ec1.firebaseio.com', 'apiKey': 'AIzaSyB2O7ynTcoPdznmhe5huHIhCbjfzcB2LKs', authDomain: 'dextroid-b1ec1.firebaseapp.com', projectId: 'dextroid-b1ec1' };
const MAX_ORDERS = 1000;

async function mainAsync() {
    let zeroEx: ZeroEx;
    let orderWatcher: OrderWatcher;
    const provider = new Web3ProviderEngine();
    const rpcSubprovider = new RPCSubprovider({
        rpcUrl: 'https://mainnet.infura.io/',
    });
    provider.addProvider(rpcSubprovider);
    provider.start();
    const web3Wrapper = new Web3Wrapper(provider);
    const networkId = await web3Wrapper.getNetworkIdAsync();
    const config = {
        networkId,
    };
    zeroEx = new ZeroEx(provider, config);
    orderWatcher = await zeroEx.createOrderWatcherAsync({
        stateLayer: BlockParamLiteral.Latest,
        isVerbose: true,
    });

    const seenOrders: { [orderHash: string]: boolean } = {};
    zeroEx.exchange.subscribe<LogFillContractEventArgs>(
        ExchangeEvents.LogFill,
        {},
        (err: null | Error, logEvent?: DecodedLogEvent<LogFillContractEventArgs>) => {
            if (!_.isNull(err)) {
                logUtils.warn('Log subscription error: ', err);
            }
            if (_.isUndefined(logEvent)) {
                throw new Error(`logEvent cannot be undefined if err is not null`);
            }
            if (!logEvent.isRemoved && seenOrders[logEvent.log.args.orderHash]) {
                logUtils.warn(`LogFill event found for: ${logEvent.log.args.orderHash}`);
            }
        },
    );

    orderWatcher.subscribe((err: Error | null, orderState: OrderState | undefined) => {
        if (err) {
            logUtils.warn(`OrderWatcher subscription callback recevied error: ${err.message}`);
            return;
        }
        if (_.isUndefined(orderState)) {
            throw new Error(`OrderState cannot be undefined if err is not null`);
        }
        if (!orderState.isValid) {
            const orderStateInvalid = orderState as OrderStateInvalid;
            orderWatcher.removeOrder(orderStateInvalid.orderHash);
            logUtils.warn(`Removed invalidated order ${orderStateInvalid.orderHash} - ${orderStateInvalid.error}`);
        } else {
            const orderStateValid = orderState as OrderStateValid;
            logUtils.warn(`Order state updated, but still valid: ${orderStateValid.orderHash}`);
        }
    });

    const admin = require('firebase-admin');
    const serviceAccount = require('../src/firebase-credentials.json');
    const app = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://dextroid-b1ec1.firebaseio.com',
    });
    const db = app.firestore()
    const orders = {}
    db.collection('orders')
        .where('status', '==', 'available')
        .where('makerTokenSymbol', '==', 'ZRX')
        .where('source', '==', null)
        .orderBy('createdAt', 'desc')
        .limit(MAX_ORDERS)
        // @ts-ignore
        .onSnapshot(querySnapshot => {
            // @ts-ignore
            querySnapshot.forEach(doc => {
                const orderHash = doc.id
                const signedOrder: SignedOrder = doc.data().signedOrder;
                signedOrder.expirationUnixTimestampSec = new BigNumber(
                    signedOrder.expirationUnixTimestampSec,
                );
                signedOrder.makerFee = new BigNumber(signedOrder.makerFee);
                signedOrder.makerTokenAmount = new BigNumber(signedOrder.makerTokenAmount);
                signedOrder.takerFee = new BigNumber(signedOrder.takerFee);
                signedOrder.takerTokenAmount = new BigNumber(signedOrder.takerTokenAmount);

                if (_.isUndefined(seenOrders[orderHash])) {
                    orderWatcher.addOrder(signedOrder);
                    seenOrders[orderHash] = true;
                    console.log(`Added order to watcher: ${orderHash}`);
                }
            });
        });
}

mainAsync();
