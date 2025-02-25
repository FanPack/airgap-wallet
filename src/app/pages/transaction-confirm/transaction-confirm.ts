import { ProtocolService } from '@airgap/angular-core'
import { BeaconRequestOutputMessage, BeaconResponseInputMessage } from '@airgap/beacon-sdk'
import {
  AirGapMarketWallet,
  IACMessageDefinitionObject,
  IACMessageType,
  ICoinProtocol,
  MainProtocolSymbols,
  SignedTransaction,
  TezosSaplingProtocol,
  RawEthereumTransaction
} from '@airgap/coinlib-core'
import { NetworkType } from '@airgap/coinlib-core/utils/ProtocolNetwork'
import { Component } from '@angular/core'
import { ActivatedRoute, Router } from '@angular/router'
import { AlertController, LoadingController, Platform, ToastController } from '@ionic/angular'
import BigNumber from 'bignumber.js'
import { AccountProvider } from 'src/app/services/account/account.provider'
import { BrowserService } from 'src/app/services/browser/browser.service'
import { DataService, DataServiceKey } from 'src/app/services/data/data.service'

import { BeaconService } from '../../services/beacon/beacon.service'
import { PushBackendProvider } from '../../services/push-backend/push-backend'
import { ErrorCategory, handleErrorSentry } from '../../services/sentry-error-handler/sentry-error-handler'
import { WalletStorageKey, WalletStorageService } from '../../services/storage/storage'
import { WalletconnectService } from 'src/app/services/walletconnect/walletconnect.service'

const SECOND: number = 1000

const TOAST_DURATION: number = SECOND * 3
const TOAST_ERROR_DURATION: number = SECOND * 5
const TIMEOUT_TRANSACTION_QUEUED: number = SECOND * 20

@Component({
  selector: 'page-transaction-confirm',
  templateUrl: 'transaction-confirm.html',
  styleUrls: ['./transaction-confirm.scss']
})
export class TransactionConfirmPage {
  public messageDefinitionObjects: IACMessageDefinitionObject[]

  public txInfos: [string, ICoinProtocol, BeaconRequestOutputMessage | { transaction: RawEthereumTransaction; id: string }][] = []
  public protocols: ICoinProtocol[] = []

  constructor(
    private readonly loadingCtrl: LoadingController,
    private readonly toastCtrl: ToastController,
    private readonly router: Router,
    private readonly route: ActivatedRoute,
    private readonly alertCtrl: AlertController,
    private readonly platform: Platform,
    private readonly storageProvider: WalletStorageService,
    private readonly beaconService: BeaconService,
    private readonly pushBackendProvider: PushBackendProvider,
    private readonly browserService: BrowserService,
    private readonly accountService: AccountProvider,
    private readonly protocolService: ProtocolService,
    private readonly dataService: DataService,
    private readonly walletConnectService: WalletconnectService
  ) {}

  public dismiss(): void {
    this.router.navigateByUrl('/tabs/portfolio').catch(handleErrorSentry(ErrorCategory.NAVIGATION))
  }

  public async ionViewWillEnter() {
    await this.platform.ready()
    if (this.route.snapshot.data.special) {
      const info = this.route.snapshot.data.special
      this.messageDefinitionObjects = info.messageDefinitionObjects
    }

    // TODO: Multi messages
    // tslint:disable-next-line:no-unnecessary-type-assertion
    this.messageDefinitionObjects.forEach(async (messageObject) => {
      const protocol = await this.protocolService.getProtocol(messageObject.protocol)

      const wallet = this.accountService.walletBySerializerAccountIdentifier(
        (messageObject.payload as SignedTransaction).accountIdentifier,
        messageObject.protocol
      )

      const [request, savedProtocol] = await this.beaconService.getVaultRequest()

      const selectedProtocol =
        request && savedProtocol && savedProtocol.identifier === protocol.identifier
          ? savedProtocol
          : wallet && wallet.protocol
          ? wallet.protocol
          : protocol

      this.txInfos.push([(messageObject.payload as SignedTransaction).transaction, selectedProtocol, request])
      this.protocols.push(selectedProtocol)
    })
  }

  public async broadcastTransaction() {
    if (this.protocols.length === 1 && this.protocols[0].identifier === MainProtocolSymbols.XTZ_SHIELDED) {
      // temporary
      await this.wrapInTezosOperation(this.protocols[0] as TezosSaplingProtocol, this.txInfos[0][0])
      return
    }

    const loading = await this.loadingCtrl.create({
      message: 'Broadcasting...'
    })

    loading.present().catch(handleErrorSentry(ErrorCategory.NAVIGATION))

    const interval = setTimeout(async () => {
      loading.dismiss().catch(handleErrorSentry(ErrorCategory.NAVIGATION))
      const toast: HTMLIonToastElement = await this.toastCtrl.create({
        duration: TOAST_DURATION,
        message: 'Transaction queued. It might take some time until your TX shows up!',
        buttons: [
          {
            text: 'Ok',
            role: 'cancel'
          }
        ],
        position: 'bottom'
      })
      toast.present().catch(handleErrorSentry(ErrorCategory.IONIC_TOAST))

      this.router.navigateByUrl('/tabs/portfolio').catch(handleErrorSentry(ErrorCategory.NAVIGATION))
    }, TIMEOUT_TRANSACTION_QUEUED)

    this.txInfos.forEach(async ([signedTx, protocol, request], index) => {
      protocol
        .broadcastTransaction(signedTx)
        .then(async (txId) => {
          if (request) {
            // TODO: Type
            if (request['transaction']) {
              this.walletConnectService.approveRequest(request.id, txId)
            } else {
              const response = {
                id: request.id,
                type: this.beaconService.getResponseByRequestType((request as BeaconRequestOutputMessage).type),
                transactionHash: txId
              } as BeaconResponseInputMessage
              this.beaconService.respond(response, request as any).catch(handleErrorSentry(ErrorCategory.BEACON))
            }
          }

          if (interval) {
            clearInterval(interval)
          }
          // TODO: Remove once we introduce pending transaction handling
          // TODO: Multi messages
          // tslint:disable-next-line:no-unnecessary-type-assertion
          const signedTxWrapper = this.messageDefinitionObjects[index].payload as SignedTransaction
          const lastTx: {
            protocol: string
            accountIdentifier: string
            date: number
          } = {
            protocol: this.messageDefinitionObjects[index].protocol,
            accountIdentifier: signedTxWrapper.accountIdentifier,
            date: new Date().getTime()
          }
          this.storageProvider.set(WalletStorageKey.LAST_TX_BROADCAST, lastTx).catch(handleErrorSentry(ErrorCategory.STORAGE))

          loading.dismiss().catch(handleErrorSentry(ErrorCategory.NAVIGATION))

          this.showTransactionSuccessfulAlert(protocol, txId)

          // POST TX TO BACKEND
          // Only send it if we are on mainnet
          if (protocol.options.network.type === NetworkType.MAINNET) {
            const signed = (
              await protocol.getTransactionDetailsFromSigned(this.messageDefinitionObjects[index].payload as SignedTransaction)
            )[0] as any
            // necessary for the transaction backend
            signed.amount = signed.amount.toString()
            signed.fee = signed.fee.toString()
            signed.signedTx = signedTx
            signed.hash = txId
            this.pushBackendProvider.postPendingTx(signed) // Don't await
          }
          // END POST TX TO BACKEND
        })
        .catch((error) => {
          if (interval) {
            clearInterval(interval)
          }

          handleErrorSentry(ErrorCategory.COINLIB)(error)

          loading.dismiss().catch(handleErrorSentry(ErrorCategory.NAVIGATION))

          // TODO: Remove this special error case once we remove web3 from the coin-lib
          if (error && error.message && error.message.startsWith('Failed to check for transaction receipt')) {
            ;(protocol.getTransactionDetailsFromSigned(this.messageDefinitionObjects[index].payload as SignedTransaction) as any).then(
              (signed) => {
                if (signed.hash) {
                  this.showTransactionSuccessfulAlert(protocol, signed.hash)
                  // POST TX TO BACKEND
                  // necessary for the transaction backend
                  signed.amount = signed.amount.toString()
                  signed.fee = signed.fee.toString()
                  signed.signedTx = signedTx
                  this.pushBackendProvider.postPendingTx(signed) // Don't await
                  // END POST TX TO BACKEND
                } else {
                  handleErrorSentry(ErrorCategory.COINLIB)('No transaction hash present in signed ETH transaction')
                }
              }
            )
          } else {
            this.toastCtrl
              .create({
                duration: TOAST_ERROR_DURATION,
                message: 'Transaction broadcasting failed: ' + error,
                buttons: [
                  {
                    text: 'Ok',
                    role: 'cancel'
                  }
                ],
                position: 'bottom'
              })
              .then((toast) => {
                toast.present().catch(handleErrorSentry(ErrorCategory.NAVIGATION))
              })
              .catch(handleErrorSentry(ErrorCategory.IONIC_TOAST))
          }
          this.router.navigateByUrl('/tabs/portfolio').catch(handleErrorSentry(ErrorCategory.NAVIGATION))
        })
    })
  }

  private async showTransactionSuccessfulAlert(protocol: ICoinProtocol, transactionHash: string): Promise<void> {
    const blockexplorer: string = await protocol.getBlockExplorerLinkForTxId(transactionHash)
    this.alertCtrl
      .create({
        header: 'Transaction broadcasted!',
        message: 'Your transaction has been successfully broadcasted',
        buttons: [
          {
            text: 'Open Blockexplorer',
            handler: (): void => {
              this.browserService.openUrl(blockexplorer)

              this.router.navigateByUrl('/tabs/portfolio').catch(handleErrorSentry(ErrorCategory.NAVIGATION))
            }
          },
          {
            text: 'Ok',
            handler: (): void => {
              this.router.navigateByUrl('/tabs/portfolio').catch(handleErrorSentry(ErrorCategory.NAVIGATION))
            }
          }
        ]
      })
      .then((alert: HTMLIonAlertElement) => {
        alert.present().catch(handleErrorSentry(ErrorCategory.NAVIGATION))
      })
      .catch(handleErrorSentry(ErrorCategory.IONIC_ALERT))
  }

  private async wrapInTezosOperation(protocol: TezosSaplingProtocol, transaction: string): Promise<void> {
    this.selectTezosTzAccount(protocol, async (wallet) => {
      try {
        const unsignedTx = await protocol.wrapSaplingTransactions(
          wallet.publicKey,
          transaction,
          new BigNumber(wallet.protocol.feeDefaults.medium).shiftedBy(wallet.protocol.feeDecimals).toString(),
          true
        )

        const airGapTxs = await protocol.getTransactionDetails(
          {
            publicKey: wallet.publicKey,
            transaction: unsignedTx
          },
          { knownViewingKeys: this.accountService.getKnownViewingKeys() }
        )

        this.accountService.startInteraction(wallet, unsignedTx, IACMessageType.TransactionSignRequest, airGapTxs) 
      } catch (error) {
        this.toastCtrl
          .create({
            duration: TOAST_ERROR_DURATION,
            message: 'Failed to prepare tezos operation: ' + error,
            buttons: [
              {
                text: 'Ok',
                role: 'cancel'
              }
            ],
            position: 'bottom'
          })
          .then((toast) => {
            toast.present().catch(handleErrorSentry(ErrorCategory.NAVIGATION))
          })
          .catch(handleErrorSentry(ErrorCategory.IONIC_TOAST))
      }
    })
  }

  private selectTezosTzAccount(protocol: ICoinProtocol, onSelected: (wallet: AirGapMarketWallet) => void): void {
    const wallets: AirGapMarketWallet[] = this.accountService.getActiveWalletList()
      const compatibleWallets = wallets.filter((wallet: AirGapMarketWallet) => wallet.protocol.identifier === MainProtocolSymbols.XTZ && wallet.protocol.options.network.identifier === protocol.options.network.identifier)
      const info = {
        actionType: 'broadcast',
        targetIdentifier: protocol.identifier,
        compatibleWallets,
        incompatibleWallets: [],
        callback: onSelected
      }
      this.dataService.setData(DataServiceKey.ACCOUNTS, info)
      this.router.navigateByUrl(`/select-wallet/${DataServiceKey.ACCOUNTS}`).catch(handleErrorSentry(ErrorCategory.NAVIGATION))
  }
}
