import { ProtocolService } from '@airgap/angular-core'
import {
  AirGapMarketWallet,
  AirGapWalletStatus,
  EthereumProtocol,
  FeeDefaults,
  ICoinProtocol,
  MainProtocolSymbols,
  ProtocolSymbols,
  SubProtocolSymbols
} from '@airgap/coinlib-core'
import { NetworkType } from '@airgap/coinlib-core/utils/ProtocolNetwork'
import { Component, NgZone } from '@angular/core'
import { FormBuilder, FormGroup, Validators } from '@angular/forms'
import { Router } from '@angular/router'
import { AlertController, LoadingController, ModalController } from '@ionic/angular'
import { TranslateService } from '@ngx-translate/core'
import { BigNumber } from 'bignumber.js'
import { BehaviorSubject, Subject } from 'rxjs'
import { debounceTime, first, takeUntil } from 'rxjs/operators'

import { UIWidget } from '../../models/widgets/UIWidget'
import { AccountProvider } from '../../services/account/account.provider'
import { DataService, DataServiceKey } from '../../services/data/data.service'
import { ExchangeEnum, ExchangeProvider, ExchangeTransactionDetails } from '../../services/exchange/exchange'
import { ExchangeTransaction, ExchangeUI } from '../../services/exchange/exchange.interface'
import { PriceService } from '../../services/price/price.service'
import { ErrorCategory, handleErrorSentry } from '../../services/sentry-error-handler/sentry-error-handler'
import { WalletStorageKey, WalletStorageService } from '../../services/storage/storage'

import { ExchangeSelectPage } from './../exchange-select/exchange-select.page'

interface ExchangeFormState<T> {
  value: T
  dirty: boolean
}
interface ExchangeState {
  fromWalletBalance: BigNumber | null
  feeDefaults: FeeDefaults
  feeCurrentMarketPrice: number | null
  disableFeeSlider: boolean
  disableExchangeButton: boolean
  disableAdvancedMode: boolean
  estimatingFeeDefaults: boolean
  fee: ExchangeFormState<string>
  feeLevel: ExchangeFormState<number>
  isAdvancedMode: ExchangeFormState<boolean>
  providerState: {} | null

  lastUpdated: (keyof Omit<ExchangeState, 'lastUpdated'>)[]
}

enum ExchangePageState {
  LOADING,
  ONBOARDING,
  NOT_ENOUGH_CURRENCIES,
  EXCHANGE
}

@Component({
  selector: 'page-exchange',
  templateUrl: 'exchange.html',
  styleUrls: ['./exchange.scss']
})
export class ExchangePage {
  // TODO remove unused properties
  public selectedFromProtocol: ICoinProtocol
  public selectedToProtocol: ICoinProtocol
  public supportedProtocolsFrom: ProtocolSymbols[] = []
  public supportedProtocolsTo: ProtocolSymbols[] = []
  public currentlyNotSupported: boolean = false
  public fromWallet: AirGapMarketWallet
  public supportedFromWallets: AirGapMarketWallet[]
  public toWallet: AirGapMarketWallet
  public supportedToWallets: AirGapMarketWallet[]
  public minExchangeAmount: BigNumber = new BigNumber(0)
  public amount: BigNumber = new BigNumber(0)
  public exchangeAmount: BigNumber
  public disableExchangeSelection: boolean = false

  public activeExchange$: BehaviorSubject<ExchangeEnum | undefined> = new BehaviorSubject(undefined)
  public activeExchange: ExchangeEnum

  public exchangeForm: FormGroup

  get isTZBTCExchange(): boolean {
    return (
      (this.selectedFromProtocol !== undefined && this.selectedFromProtocol.identifier === SubProtocolSymbols.XTZ_BTC) ||
      (this.selectedToProtocol !== undefined && this.selectedToProtocol.identifier === SubProtocolSymbols.XTZ_BTC)
    )
  }

  // temporary field until we figure out how to handle Substrate fee/tip model
  private isSubstrate: boolean = false

  public ExchangeEnum: typeof ExchangeEnum = ExchangeEnum

  public exchangePageStates: typeof ExchangePageState = ExchangePageState
  public exchangePageState: ExchangePageState = ExchangePageState.LOADING

  public exchangeWidgets: UIWidget[] = []

  public loading: HTMLIonLoadingElement

  public state: ExchangeState
  private walletList: AirGapMarketWallet[]
  private _state: ExchangeState | undefined = undefined
  private readonly state$: BehaviorSubject<ExchangeState> = new BehaviorSubject(this._state)
  private readonly ngDestroyed$: Subject<void> = new Subject()

  constructor(
    public formBuilder: FormBuilder,
    private readonly router: Router,
    private readonly exchangeProvider: ExchangeProvider,
    private readonly storageProvider: WalletStorageService,
    private readonly accountProvider: AccountProvider,
    private readonly dataService: DataService,
    private readonly loadingController: LoadingController,
    private readonly translateService: TranslateService,
    private readonly modalController: ModalController,
    private readonly alertCtrl: AlertController,
    private readonly priceService: PriceService,
    private readonly protocolService: ProtocolService,
    private readonly _ngZone: NgZone
  ) {}

  public ionViewWillEnter() {
    this.initForm()
    this.initState()

    this.accountProvider.allWallets$
      .asObservable()
      .pipe(takeUntil(this.ngDestroyed$))
      .subscribe((wallets: AirGapMarketWallet[]) => {
        this.walletList = wallets.filter((wallet) => wallet.status === AirGapWalletStatus.ACTIVE)
      })

    this.exchangeProvider
      .getActiveExchange()
      .pipe(takeUntil(this.ngDestroyed$))
      .subscribe((exchange: ExchangeEnum) => {
        this.changeExchange(exchange).catch(handleErrorSentry(ErrorCategory.OTHER))
      })

    this.activeExchange$.pipe(takeUntil(this.ngDestroyed$)).subscribe((exchange: ExchangeEnum) => {
      this.activeExchange = exchange
    })

    this.setup()
      .then(() => {
        try {
          this.onChanges()
          this.updateFeeEstimate()
        } catch (err) {
          console.error(err)
        }
      })
      .catch((err) => {
        console.error(err)
        this.showLoadingErrorAlert()
      })
  }

  private async changeExchange(exchange: ExchangeEnum): Promise<void> {
    this.exchangeForm.removeControl(this.activeExchange)
    this.updateState({ providerState: null })

    this.activeExchange$.next(exchange)

    const exchangeUI: ExchangeUI = await this.exchangeProvider.getCustomUI()
    this.exchangeWidgets = exchangeUI.widgets

    if (exchangeUI.form) {
      this.exchangeForm.addControl(this.activeExchange, exchangeUI.form)
      this.updateState({ providerState: exchangeUI.form.value })
      this.exchangeForm.controls[this.activeExchange].valueChanges.subscribe((providerState) => {
        this.updateState({ providerState })
      })
    }
  }

  private initForm(): void {
    this.exchangeForm = this.formBuilder.group({
      feeLevel: [0, [Validators.required]],
      fee: [0, Validators.compose([Validators.required])],
      isAdvancedMode: [false, []]
    })
  }

  private initState(): void {
    this._state = {
      fromWalletBalance: null,
      feeDefaults: {
        low: '0',
        medium: '0',
        high: '0'
      },
      disableAdvancedMode: this.isSubstrate,
      feeCurrentMarketPrice: null,
      disableFeeSlider: true,
      disableExchangeButton: true,
      estimatingFeeDefaults: false,
      feeLevel: {
        value: this.exchangeForm.controls.feeLevel.value,
        dirty: false
      },
      fee: {
        value: this.exchangeForm.controls.fee.value,
        dirty: false
      },
      isAdvancedMode: {
        value: this.exchangeForm.controls.isAdvancedMode.value,
        dirty: false
      },
      providerState: null,

      lastUpdated: []
    }
    this.state = this._state
    this.updateState(this.state)
  }

  private updateTransactionForm(formState: { [key: string]: ExchangeFormState<any> }) {
    const formValues = this.exchangeForm.value
    const updated = {}

    Object.keys(formValues).forEach((key: string) => {
      if (key in formState && !formState[key].dirty && formState[key].value !== formValues[key]) {
        updated[key] = formState[key].value
      }
    })

    this._ngZone.run(() => {
      this.exchangeForm.patchValue(updated, { emitEvent: false })
      Object.keys(updated).forEach((key: string) => {
        this.exchangeForm.controls[key].markAsDirty()
      })
    })
  }

  private onStateUpdated(newState: ExchangeState): void {
    this.state = newState

    this.updateTransactionForm({
      fee: this.state.fee,
      feeLevel: this.state.feeLevel,
      isAdvancedMode: this.state.isAdvancedMode
    })

    if (this.state.lastUpdated.includes('providerState')) {
      this.loadDataFromExchange().then(() => this.updateFeeEstimate())
    }
  }

  public onChanges(): void {
    this.state$.pipe(debounceTime(200)).subscribe((state: ExchangeState) => {
      this.onStateUpdated(state)
    })

    this.exchangeForm
      .get('fee')
      .valueChanges.pipe(debounceTime(500))
      .subscribe((value: string) => {
        const fee = new BigNumber(value)
        this.updateState({
          fee: {
            value: fee.isNaN() ? '' : fee.toFixed(),
            dirty: true
          }
        })
      })

    this.exchangeForm.get('feeLevel').valueChanges.subscribe((value: number) => {
      const fee = new BigNumber(this.getFeeFromLevel(value))
      this.updateState(
        {
          fee: {
            value: fee.toFixed(),
            dirty: false
          },
          feeLevel: {
            value,
            dirty: true
          },
          disableExchangeButton: this.exchangeForm.invalid || this.amount.lte(0)
        },
        false
      )
    })

    this.exchangeForm.get('isAdvancedMode').valueChanges.subscribe((value: boolean) => {
      this.updateState(
        {
          isAdvancedMode: {
            value,
            dirty: true
          },
          disableExchangeButton: this.exchangeForm.invalid || new BigNumber(this.amount).lte(0)
        },
        false
      )
    })
  }

  private async updateFeeEstimate(): Promise<void> {
    if (this._state) {
      let feeCurrentMarketPrice
      if (this.selectedFromProtocol?.identifier.startsWith(SubProtocolSymbols.ETH_ERC20)) {
        feeCurrentMarketPrice = this.priceService
          .getCurrentMarketPrice(new EthereumProtocol(), 'USD')
          .then((price: BigNumber) => price.toNumber())
      } else {
        feeCurrentMarketPrice = (await this.priceService.getCurrentMarketPrice(this.selectedFromProtocol, 'USD')).toNumber()
      }

      this.updateState({
        feeCurrentMarketPrice
      })
      this.updateState({
        estimatingFeeDefaults: true,
        disableFeeSlider: true,
        disableExchangeButton: true
      })

      const feeDefaults: FeeDefaults = await this.estimateFees().catch(() => undefined)

      const feeLevel: number = feeDefaults && !this.isSubstrate ? 1 : this._state.feeLevel.value

      this.updateState({
        estimatingFeeDefaults: false,
        feeDefaults,
        fee: {
          value: new BigNumber(this.getFeeFromLevel(feeLevel, feeDefaults)).toFixed(),
          dirty: false
        },
        feeLevel: {
          value: feeLevel,
          dirty: false
        },
        disableFeeSlider: !feeDefaults,
        disableExchangeButton: !feeDefaults || this.exchangeForm.invalid || this.amount.lte(0)
      })
    }
  }

  private async estimateFees(amount?: BigNumber): Promise<FeeDefaults | undefined> {
    return this.exchangeProvider.estimateFee(this.fromWallet, this.toWallet, (amount ?? this.amount).toString(), this.state.providerState)
  }

  private getFeeFromLevel(feeLevel: number, feeDefaults?: FeeDefaults): string {
    const defaults = feeDefaults || this._state.feeDefaults
    switch (feeLevel) {
      case 0:
        return defaults.low
      case 1:
        return defaults.medium
      case 2:
        return defaults.high
      default:
        return defaults.medium
    }
  }

  private async filterSupportedProtocols(protocols: ProtocolSymbols[], filterZeroBalance: boolean = true): Promise<ProtocolSymbols[]> {
    const result: ProtocolSymbols[] = protocols.filter((supportedProtocol: ProtocolSymbols) =>
      this.walletList.some(
        (wallet: AirGapMarketWallet) =>
          wallet.protocol.identifier === supportedProtocol &&
          (!filterZeroBalance || (filterZeroBalance && wallet.getCurrentBalance().isGreaterThan(0)))
      )
    )
    const tzbtcIndex: number = result.indexOf(SubProtocolSymbols.XTZ_BTC)
    if (
      tzbtcIndex !== -1 &&
      !this.walletList.some((wallet: AirGapMarketWallet) => wallet.protocol.identifier === MainProtocolSymbols.BTC)
    ) {
      result.splice(tzbtcIndex, 1)
    }

    return result
  }

  private async setup(): Promise<void> {
    await this.activeExchange$.pipe(first()).toPromise()
    const fromProtocols: ProtocolSymbols[] = await this.getSupportedFromProtocols()
    if (fromProtocols.length === 0) {
      this.supportedProtocolsFrom = []
      this.supportedProtocolsTo = []
      this.selectedFromProtocol = undefined
      this.selectedToProtocol = undefined
      this.exchangePageState = ExchangePageState.NOT_ENOUGH_CURRENCIES
      throw new Error('could not set up exchange')
    }
    this.supportedProtocolsFrom = fromProtocols
    let currentFromProtocol: ProtocolSymbols
    if (this.selectedFromProtocol !== undefined && this.supportedProtocolsFrom.includes(this.selectedFromProtocol.identifier)) {
      currentFromProtocol = this.selectedFromProtocol.identifier
    } else {
      currentFromProtocol = fromProtocols[0]
    }
    await this.setFromProtocol(await this.protocolService.getProtocol(currentFromProtocol))

    if (this.exchangePageState === ExchangePageState.LOADING) {
      const hasShownOnboarding = await this.storageProvider.get(WalletStorageKey.EXCHANGE_INTEGRATION)
      if (!hasShownOnboarding) {
        this.exchangePageState = ExchangePageState.ONBOARDING
        return
      }
    }

    if (this.supportedProtocolsFrom.length > 0 && this.supportedProtocolsTo.length > 0) {
      this.exchangePageState = ExchangePageState.EXCHANGE
    }
  }

  private async showLoadingErrorAlert() {
    const faultyExchange = this.activeExchange
    this.exchangeProvider.switchActiveExchange()
    const newExchange = this.activeExchange
    this.setup() // setup new exchange
      .then(() => this.switchExchange(faultyExchange, newExchange))
      .then(() => {
        this.onChanges()
      })
      .catch(() => this.displaySetupFail())
  }

  private async switchExchange(faultyExchange: string, newExchange: string) {
    const alert: HTMLIonAlertElement = await this.alertCtrl.create({
      header: this.translateService.instant('exchange.loading.setup'),
      message: `${faultyExchange} could currently not be loaded, switched to ${newExchange}`, // this.translateService.instant('exchange.loading.message'),
      backdropDismiss: false,
      buttons: [
        {
          text: 'ok',
          role: 'cancel'
        }
      ]
    })
    this.disableExchangeSelection = true // temporarily disable user to switch to exchange for which loading error occured
    alert.present().catch(handleErrorSentry(ErrorCategory.IONIC_ALERT))
  }

  private async displaySetupFail() {
    const alert: HTMLIonAlertElement = await this.alertCtrl.create({
      header: this.translateService.instant('exchange.loading.setup'),
      message: this.translateService.instant('exchange.loading.message'),
      backdropDismiss: false,
      buttons: [
        {
          text: 'ok',
          role: 'cancel'
        }
      ]
    })
    alert.present().catch(handleErrorSentry(ErrorCategory.IONIC_ALERT))
  }

  private async getSupportedFromProtocols(): Promise<ProtocolSymbols[]> {
    const allFromProtocols = await this.exchangeProvider.getAvailableFromCurrencies()
    allFromProtocols.push(SubProtocolSymbols.XTZ_BTC, MainProtocolSymbols.BTC_SEGWIT)
    const supportedFromProtocols = await this.filterSupportedProtocols(allFromProtocols)
    const exchangeableFromProtocols = (
      await Promise.all(
        supportedFromProtocols.map(async (fromProtocol) => {
          if (fromProtocol === SubProtocolSymbols.XTZ_BTC || fromProtocol === MainProtocolSymbols.BTC_SEGWIT) {
            return fromProtocol
          }
          const availableToCurrencies = await this.exchangeProvider.getAvailableToCurrenciesForCurrency(fromProtocol)
          return availableToCurrencies.length > 0 ? fromProtocol : undefined
        })
      )
    ).filter((fromProtocol) => fromProtocol !== undefined)
    return exchangeableFromProtocols
  }

  private async getSupportedToProtocols(from: string): Promise<ProtocolSymbols[]> {
    if (from === SubProtocolSymbols.XTZ_BTC) {
      return this.filterSupportedProtocols([MainProtocolSymbols.BTC], false)
    }
    const toProtocols = await this.exchangeProvider.getAvailableToCurrenciesForCurrency(from)
    if (from === MainProtocolSymbols.BTC) {
      toProtocols.push(SubProtocolSymbols.XTZ_BTC)
    } else {
      toProtocols.push(MainProtocolSymbols.BTC_SEGWIT)
    }
    return this.filterSupportedProtocols(toProtocols, false)
  }

  async setFromProtocol(protocol: ICoinProtocol): Promise<void> {
    this.selectedFromProtocol = protocol
    this.supportedProtocolsTo = await this.getSupportedToProtocols(protocol.identifier)

    if (this.supportedProtocolsTo.length === 0) {
      this.supportedProtocolsFrom = []
      this.supportedProtocolsTo = []
      this.selectedFromProtocol = undefined
      this.selectedToProtocol = undefined
      this.exchangePageState = ExchangePageState.NOT_ENOUGH_CURRENCIES
      return
    }

    if (
      this.selectedToProtocol === undefined ||
      this.selectedFromProtocol.identifier === this.selectedToProtocol.identifier ||
      !this.supportedProtocolsTo.includes(this.selectedToProtocol.identifier)
    ) {
      const toProtocol = await this.protocolService.getProtocol(this.supportedProtocolsTo[0])
      this.selectedToProtocol = toProtocol
      this.loadWalletsForSelectedToProtocol()
    }

    this.loadWalletsForSelectedFromProtocol()
    this.loadDataFromExchange()
    // TODO: this is needed to update the amount in the portfolio-item component, need to find a better way to do this.
    this.accountProvider.triggerWalletChanged()
    this.updateFeeEstimate()
  }

  async setToProtocol(protocol: ICoinProtocol): Promise<void> {
    this.selectedToProtocol = protocol
    this.loadWalletsForSelectedToProtocol()
    this.loadDataFromExchange()
    // TODO: this is needed to update the amount in the portfolio-item component, need to find a better way to do this.
    this.accountProvider.triggerWalletChanged()
  }

  private loadWalletsForSelectedFromProtocol() {
    this.supportedFromWallets = this.walletsForProtocol(this.selectedFromProtocol.identifier, true)
    // Only set wallet if it's another protocol or not available
    if (this.shouldReplaceActiveWallet(this.fromWallet, this.supportedFromWallets)) {
      this.fromWallet = this.supportedFromWallets[0]
      this.updateState({
        fromWalletBalance: this.fromWallet?.getCurrentBalance()
      })
    }
  }

  private loadWalletsForSelectedToProtocol() {
    this.supportedToWallets = this.walletsForProtocol(this.selectedToProtocol.identifier, false)
    this.toWallet = this.supportedToWallets[0]
    // Only set wallet if it's another protocol or not available
    if (this.shouldReplaceActiveWallet(this.toWallet, this.supportedToWallets)) {
      this.toWallet = this.supportedToWallets[0]
    }
  }

  private walletsForProtocol(protocol: string, filterZeroBalance: boolean = true): AirGapMarketWallet[] {
    return this.walletList.filter(
      (wallet) =>
        wallet.protocol.identifier === protocol &&
        wallet.protocol.options.network.type === NetworkType.MAINNET &&
        (!filterZeroBalance || wallet.getCurrentBalance().isGreaterThan(0))
    )
  }

  private shouldReplaceActiveWallet(wallet: AirGapMarketWallet, walletArray: AirGapMarketWallet[]): boolean {
    return (
      !wallet ||
      wallet.protocol.identifier !== walletArray[0].protocol.identifier ||
      walletArray.every((supportedWallet) => !this.accountProvider.isSameWallet(supportedWallet, wallet))
    )
  }

  async setFromWallet(wallet: AirGapMarketWallet) {
    this.fromWallet = wallet
    this.isSubstrate =
      this.fromWallet.protocol.identifier === MainProtocolSymbols.KUSAMA ||
      this.selectedFromProtocol.identifier === MainProtocolSymbols.POLKADOT
    this.loadDataFromExchange()
    // TODO: this is needed to update the amount in the portfolio-item component, need to find a better way to do this.
    this.accountProvider.triggerWalletChanged()
  }

  async setToWallet(wallet: AirGapMarketWallet) {
    this.toWallet = wallet
    this.loadDataFromExchange()
    // TODO: this is needed to update the amount in the portfolio-item component, need to find a better way to do this.
    this.accountProvider.triggerWalletChanged()
  }

  async amountSet(amount: string) {
    this.amount = new BigNumber(amount)
    this.updateFeeEstimate()
    this.loadDataFromExchange()
  }

  private async loadDataFromExchange() {
    this.currentlyNotSupported = false
    try {
      if (this.fromWallet && this.toWallet) {
        this.minExchangeAmount = await this.getMinAmountForCurrency()
      }
      if (this.fromWallet && this.toWallet && this.amount.isGreaterThan(0)) {
        this.exchangeAmount = new BigNumber(await this.getExchangeAmount())
      } else {
        this.exchangeAmount = new BigNumber(0)
      }
    } catch (error) {
      this.currentlyNotSupported = true
    }
  }

  private async getMinAmountForCurrency(): Promise<BigNumber> {
    if (this.isTZBTCExchange) {
      return new BigNumber(0)
    }
    return new BigNumber(
      await this.exchangeProvider.getMinAmountForCurrency(this.fromWallet.protocol.identifier, this.toWallet.protocol.identifier)
    )
  }

  private async getExchangeAmount(): Promise<string> {
    if (this.isTZBTCExchange) {
      return this.amount.toFixed()
    }
    return await this.exchangeProvider.getExchangeAmount(
      this.fromWallet.protocol.identifier,
      this.toWallet.protocol.identifier,
      this.amount.toString(),
      this.state.providerState
    )
  }

  async startExchange() {
    if (this.isTZBTCExchange) {
      this.router.navigateByUrl('/exchange-custom').catch(handleErrorSentry(ErrorCategory.STORAGE))
    } else {
      const loader = await this.getAndShowLoader()
      try {
        const transaction: ExchangeTransaction = await this.exchangeProvider.createTransaction(
          this.fromWallet,
          this.toWallet,
          this.amount.toString(),
          this.state.fee.value,
          this.state.providerState
        )

        const info = {
          ...transaction,
          fromWallet: this.fromWallet,
          fromCurrency: this.fromWallet.protocol.marketSymbol,
          toWallet: this.toWallet,
          toCurrency: this.toWallet.protocol.marketSymbol
        }

        this.dataService.setData(DataServiceKey.EXCHANGE, info)
        this.router.navigateByUrl('/exchange-confirm/' + DataServiceKey.EXCHANGE).catch(handleErrorSentry(ErrorCategory.STORAGE))

        const txId = transaction.id
        let txStatus: string = (await this.exchangeProvider.getStatus(txId)).status

        const exchangeTxInfo: ExchangeTransactionDetails = {
          receivingAddress: this.toWallet.addresses[0],
          sendingAddress: this.fromWallet.addresses[0],
          fromCurrency: this.fromWallet.protocol.identifier,
          toCurrency: this.toWallet.protocol.identifier,
          amountExpectedFrom: this.amount,
          amountExpectedTo: transaction.amountExpectedTo,
          fee: transaction.fee,
          status: txStatus,
          exchange: this.activeExchange as ExchangeEnum,
          id: txId,
          timestamp: new BigNumber(Date.now()).toNumber()
        }

        this.exchangeProvider.pushExchangeTransaction(exchangeTxInfo)
      } catch (error) {
        console.error(error)
      } finally {
        this.hideLoader(loader)
      }
    }
  }

  async doRadio(): Promise<void> {
    const modal: HTMLIonModalElement = await this.modalController.create({
      component: ExchangeSelectPage,
      componentProps: {
        activeExchange: this.activeExchange
      }
    })

    modal.present().catch((err) => console.error(err))

    modal
      .onDidDismiss()
      .then(async () => {
        await this.setup()
      })
      .catch(handleErrorSentry(ErrorCategory.IONIC_MODAL))
  }

  dismissExchangeOnboarding() {
    this.setup()
    this.storageProvider.set(WalletStorageKey.EXCHANGE_INTEGRATION, true).catch(handleErrorSentry(ErrorCategory.STORAGE))
  }

  goToAddCoinPage() {
    this.router.navigateByUrl('/account-add')
  }

  private async getAndShowLoader() {
    const loader = await this.loadingController.create({
      message: 'Preparing transaction...'
    })

    await loader.present().catch(handleErrorSentry(ErrorCategory.IONIC_LOADER))

    return loader
  }

  private hideLoader(loader: HTMLIonLoadingElement) {
    loader.dismiss().catch(handleErrorSentry(ErrorCategory.IONIC_LOADER))
  }

  private updateState(newState: Partial<ExchangeState>, debounce: boolean = true): void {
    if (!this._state) {
      return
    }

    this._state = this.reduceState(this._state, newState)

    if (debounce) {
      this.state$.next(this._state)
    } else {
      this.onStateUpdated(this._state)
    }
  }

  private reduceState(currentState: ExchangeState, newState: Partial<Omit<ExchangeState, 'lastUpdated'>>): ExchangeState {
    return {
      fromWalletBalance: newState.fromWalletBalance !== undefined ? newState.fromWalletBalance : currentState.fromWalletBalance,
      feeDefaults: newState.feeDefaults || currentState.feeDefaults,
      feeCurrentMarketPrice:
        newState.feeCurrentMarketPrice !== undefined ? newState.feeCurrentMarketPrice : currentState.feeCurrentMarketPrice,

      disableAdvancedMode:
        this.isSubstrate || (newState.disableAdvancedMode !== undefined ? newState.disableAdvancedMode : currentState.disableAdvancedMode),
      disableFeeSlider:
        this.isSubstrate || (newState.disableFeeSlider !== undefined ? newState.disableFeeSlider : currentState.disableFeeSlider),
      disableExchangeButton:
        newState.disableExchangeButton !== undefined ? newState.disableExchangeButton : currentState.disableExchangeButton,
      estimatingFeeDefaults:
        newState.estimatingFeeDefaults !== undefined ? newState.estimatingFeeDefaults : currentState.estimatingFeeDefaults,
      feeLevel: newState.feeLevel || currentState.feeLevel,
      fee: newState.fee || currentState.fee,
      isAdvancedMode: newState.isAdvancedMode || currentState.isAdvancedMode,
      providerState: newState.providerState !== undefined ? newState.providerState : currentState.providerState,

      lastUpdated: Object.keys(newState) as ExchangeState['lastUpdated']
    }
  }

  public ngOnDestroy(): void {
    this.ngDestroyed$.next()
    this.ngDestroyed$.complete()
  }
}
