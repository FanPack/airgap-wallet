import { AirGapMarketWallet } from '@airgap/coinlib-core'
import { Component, NgZone } from '@angular/core'
import { ActivatedRoute, Router } from '@angular/router'
import { LoadingController, NavController, Platform } from '@ionic/angular'

import { AccountProvider } from '../../services/account/account.provider'
import { DataService } from '../../services/data/data.service'
import { ErrorCategory, handleErrorSentry } from '../../services/sentry-error-handler/sentry-error-handler'

@Component({
  selector: 'page-account-import',
  templateUrl: 'account-import.html'
})
export class AccountImportPage {
  public wallet: AirGapMarketWallet
  public groupId?: string
  public groupLabel?: string

  public walletAlreadyExists: boolean = false

  public loading: HTMLIonLoadingElement

  constructor(
    private readonly platform: Platform,
    private readonly loadingCtrl: LoadingController,
    private readonly navController: NavController,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly wallets: AccountProvider,
    private readonly dataService: DataService,
    private readonly ngZone: NgZone
  ) {
    if (!this.route.snapshot.data.special) {
      this.router.navigateByUrl('/')
      window.alert("The address you're trying to access is invalid.")
      throw new Error()
    }
  }

  public async ionViewWillEnter(): Promise<void> {
    if (this.route.snapshot.data.special) {
      this.dataService.getImportWallet().subscribe(({ wallet, groupId, groupLabel }) => {
        this.wallet = wallet
        this.groupId = groupId
        this.groupLabel = groupLabel
        this.ionViewDidEnter()
      })
    }

    await this.platform.ready()

    this.loading = await this.loadingCtrl.create({
      message: 'Syncing...'
    })

    this.loading.present().catch(handleErrorSentry(ErrorCategory.NAVIGATION))

    this.walletAlreadyExists = false
  }

  public async ionViewDidEnter(): Promise<void> {
    this.walletAlreadyExists = this.wallets.walletExists(this.wallet)
    const airGapWorker: Worker = new Worker('./assets/workers/airgap-coin-lib.js')

    airGapWorker.onmessage = event => {
      this.wallet.addresses = event.data.addresses
      this.wallet
        .synchronize()
        .then(() => {
          this.ngZone.run(() => {
            this.wallets.triggerWalletChanged()
          })
        })
        .catch(handleErrorSentry(ErrorCategory.WALLET_PROVIDER))
      this.loading.dismiss().catch(handleErrorSentry(ErrorCategory.NAVIGATION))
    }

    airGapWorker.postMessage({
      protocolIdentifier: this.wallet.protocol.identifier,
      publicKey: this.wallet.publicKey,
      isExtendedPublicKey: this.wallet.isExtendedPublicKey,
      derivationPath: this.wallet.derivationPath,
      masterFingerprint: this.wallet.masterFingerprint
    })
  }

  public async dismiss(): Promise<void> {
    this.navController.back()
  }

  public async import(): Promise<void> {
    await this.wallets.addWallet(this.wallet, this.groupId, this.groupLabel, { override: true })
    await this.router.navigateByUrl('/tabs/portfolio', { skipLocationChange: true })
  }
}
