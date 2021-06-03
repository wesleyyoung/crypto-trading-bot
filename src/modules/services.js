const fs = require('fs');
const events = require('events');

const { createLogger, transports, format } = require('winston');

const _ = require('lodash');
const Sqlite = require('better-sqlite3');
const Notify = require('../notify/notify');
const Slack = require('../notify/slack');
const Mail = require('../notify/mail');
const Telegram = require('../notify/telegram');

const Tickers = require('../storage/tickers');
// eslint-disable-next-line import/extensions
const Ta = require('./ta.js');

const TickListener = require('./listener/tick_listener');
const CreateOrderListener = require('./listener/create_order_listener');
const TickerDatabaseListener = require('./listener/ticker_database_listener');
const ExchangeOrderWatchdogListener = require('./listener/exchange_order_watchdog_listener');
const ExchangePositionWatcher = require('./exchange/exchange_position_watcher');

const SignalLogger = require('./signal/signal_logger');
const SignalHttp = require('./signal/signal_http');

const SignalRepository = require('./repository/signal_repository');
const CandlestickRepository = require('./repository/candlestick_repository');
const StrategyManager = require('./strategy/strategy_manager');
const ExchangeManager = require('./exchange/exchange_manager');

const Trade = require('./trade');
const Http = require('./http');
const Backtest = require('./backtest');
const Backfill = require('./backfill');

const StopLossCalculator = require('./order/stop_loss_calculator');
const RiskRewardRatioCalculator = require('./order/risk_reward_ratio_calculator');
const PairsHttp = require('./pairs/pairs_http');
const OrderExecutor = require('./order/order_executor');
const OrderCalculator = require('./order/order_calculator');
const PairStateManager = require('./pairs/pair_state_manager');
const PairStateExecution = require('./pairs/pair_state_execution');
const PairConfig = require('./pairs/pair_config');
const SystemUtil = require('./system/system_util');
const TechnicalAnalysisValidator = require('../utils/technical_analysis_validator');
const WinstonSqliteTransport = require('../utils/winston_sqlite_transport');
const LogsHttp = require('./system/logs_http');
const LogsRepository = require('./repository/logs_repository');
const TickerLogRepository = require('./repository/ticker_log_repository');
const TickerRepository = require('./repository/ticker_repository');
const CandlestickResample = require('./system/candlestick_resample');
const RequestClient = require('../utils/request_client');
const Throttler = require('../utils/throttler');
const Queue = require('../utils/queue');

const Bitmex = require('../exchange/bitmex');
const BitmexTestnet = require('../exchange/bitmex_testnet');
const Binance = require('../exchange/binance');
const BinanceFutures = require('../exchange/binance_futures');
const BinanceMargin = require('../exchange/binance_margin');
const Bitfinex = require('../exchange/bitfinex');
const CoinbasePro = require('../exchange/coinbase_pro');
const Noop = require('../exchange/noop');
const Bybit = require('../exchange/bybit');
const FTX = require('../exchange/ftx');

const ExchangeCandleCombine = require('./exchange/exchange_candle_combine');
const CandleExportHttp = require('./system/candle_export_http');
const CandleImporter = require('./system/candle_importer');

const OrdersHttp = require('./orders/orders_http');

let db;
let instances;
let config;
let ta;
let eventEmitter;
let logger;
let notify;
let tickers;
let queue;

let candleStickImporter;
let tickerDatabaseListener;
let tickListener;
let createOrderListener;
let exchangeOrderWatchdogListener;

let signalLogger;
let signalHttp;

let signalRepository;
let candlestickRepository;

let exchangeManager;
let backtest;
let pairStateManager;
let pairStateExecution;

let strategyManager;

let stopLossCalculator;
let riskRewardRatioCalculator;
let pairsHttp;
let orderExecutor;
let orderCalculator;
let systemUtil;
let technicalAnalysisValidator;
let logsHttp;
let logsRepository;
let tickerLogRepository;
let candlestickResample;
let exchanges;
let requestClient;
let exchangeCandleCombine;
let candleExportHttp;
let exchangePositionWatcher;
let tickerRepository;
let ordersHttp;
let pairConfig;
let throttler;

const Params = require('./services/params');

const params = new Params();

module.exports = {
  boot: async function(projectDir) {
    params.set('projectDir', projectDir);

    try {
      // eslint-disable-next-line global-require,import/no-dynamic-require
      instances = require(`${params.get('projectDir')}/instance`);
    } catch (e) {
      throw new Error(`Invalid instance.js file. Please check: ${String(e)}`);
    }

    // boot instance eg to load pairs external
    if (typeof instances.init === 'function') {
      await instances.init();
    }

    try {
      config = JSON.parse(fs.readFileSync(`${params.get('projectDir')}/conf.json`, 'utf8'));
    } catch (e) {
      throw new Error(`Invalid conf.json file. Please check: ${String(e)}`);
    }

    this.getDatabase();
  },

  getDatabase: () => {
    if (!db) {
      const myDb = Sqlite('bot.db');
      myDb.pragma('journal_mode = WAL');

      myDb.pragma('SYNCHRONOUS = 1;');
      myDb.pragma('LOCKING_MODE = EXCLUSIVE;');

      db = myDb;
    }

    return db;
  },

  getTa: function() {
    if (!ta) {
      ta = new Ta(this.getCandlestickRepository(), this.getInstances(), this.getTickers());
    }

    return ta;
  },

  getBacktest: function() {
    if (!backtest) {
      backtest = new Backtest(
        this.getInstances(),
        this.getStrategyManager(),
        this.getExchangeCandleCombine(),
        params.get('projectDir')
      );
    }

    return backtest;
  },

  getStopLossCalculator: function() {
    if (!stopLossCalculator) {
      stopLossCalculator = new StopLossCalculator(this.getTickers(), this.getLogger());
    }

    return stopLossCalculator;
  },

  getRiskRewardRatioCalculator: function() {
    if (!riskRewardRatioCalculator) {
      riskRewardRatioCalculator = new RiskRewardRatioCalculator(this.getLogger());
    }

    return riskRewardRatioCalculator;
  },

  getCandleImporter: function() {
    if (!candleStickImporter) {
      candleStickImporter = new CandleImporter(this.getCandlestickRepository());
    }

    return candleStickImporter;
  },

  getCreateOrderListener: function() {
    if (!createOrderListener) {
      createOrderListener = new CreateOrderListener(this.getExchangeManager(), this.getLogger());
    }

    return createOrderListener;
  },

  getTickListener: function() {
    if (!tickListener) {
      tickListener = new TickListener(
        this.getTickers(),
        this.getInstances(),
        this.getNotifier(),
        this.getSignalLogger(),
        this.getStrategyManager(),
        this.getExchangeManager(),
        this.getPairStateManager(),
        this.getLogger(),
        this.getSystemUtil(),
        this.getOrderExecutor(),
        this.getOrderCalculator()
      );
    }

    return tickListener;
  },

  getExchangeOrderWatchdogListener: function() {
    if (!exchangeOrderWatchdogListener) {
      exchangeOrderWatchdogListener = new ExchangeOrderWatchdogListener(
        this.getExchangeManager(),
        this.getInstances(),
        this.getStopLossCalculator(),
        this.getRiskRewardRatioCalculator(),
        this.getOrderExecutor(),
        this.getPairStateManager(),
        this.getLogger(),
        this.getTickers()
      );
    }

    return exchangeOrderWatchdogListener;
  },

  getTickerDatabaseListener: function() {
    if (!tickerDatabaseListener) {
      tickerDatabaseListener = new TickerDatabaseListener(this.getTickerRepository());
    }

    return tickerDatabaseListener;
  },

  getSignalLogger: function() {
    if (!signalLogger) {
      signalLogger = new SignalLogger(this.getSignalRepository());
    }

    return signalLogger;
  },

  getSignalHttp: function() {
    if (!signalHttp) {
      signalHttp = new SignalHttp(this.getSignalRepository());
    }

    return signalHttp;
  },

  getSignalRepository: function() {
    if (!signalRepository) {
      signalRepository = new SignalRepository(this.getDatabase());
    }

    return signalRepository;
  },

  getCandlestickRepository: function() {
    if (!candlestickRepository) {
      candlestickRepository = new CandlestickRepository(this.getDatabase());
    }

    return candlestickRepository;
  },

  getEventEmitter: function() {
    if (!eventEmitter) {
      eventEmitter = new events.EventEmitter();
    }

    return eventEmitter;
  },

  getLogger: function() {
    if (!logger) {
      logger = createLogger({
        format: format.combine(format.timestamp(), format.json()),
        transports: [
          new transports.File({
            filename: `${params.get('projectDir')}/var/log/log.log`,
            level: 'debug'
          }),
          new transports.Console({
            level: 'error'
          }),
          new WinstonSqliteTransport({
            level: 'debug',
            database_connection: this.getDatabase(),
            table: 'logs'
          })
        ]
      });
    }

    return logger;
  },

  getNotifier: function() {
    const notifiers = [];

    const configuration = this.getConfig();

    const slack = _.get(configuration, 'notify.slack');
    if (slack && slack.webhook && slack.webhook.length > 0) {
      notifiers.push(new Slack(slack));
    }

    const mailServer = _.get(configuration, 'notify.mail.server');
    if (mailServer && mailServer.length > 0) {
      notifiers.push(new Mail(this.createMailer(), this.getSystemUtil(), this.getLogger()));
    }

    const telegram = _.get(configuration, 'notify.telegram');
    if (telegram && telegram.chat_id && telegram.chat_id.length > 0 && telegram.token && telegram.token.length > 0) {
      notifiers.push(new Telegram(this.createTelegram(), telegram, this.getLogger()));
    }

    notify = new Notify(notifiers);

    return notify;
  },

  getTickers: function() {
    if (!tickers) {
      tickers = new Tickers();
    }

    return tickers;
  },

  getStrategyManager: function() {
    if (!strategyManager) {
      strategyManager = new StrategyManager(
        this.getTechnicalAnalysisValidator(),
        this.getExchangeCandleCombine(),
        this.getLogger(),
        params.get('projectDir')
      );
    }

    return strategyManager;
  },

  createWebserverInstance: function() {
    return new Http(
      this.getSystemUtil(),
      this.getTa(),
      this.getSignalHttp(),
      this.getBacktest(),
      this.getExchangeManager(),
      this.getHttpPairs(),
      this.getLogsHttp(),
      this.getCandleExportHttp(),
      this.getCandleImporter(),
      this.getOrdersHttp(),
      this.getTickers(),
      params.get('projectDir')
    );
  },

  getExchangeManager: function() {
    if (!exchangeManager) {
      exchangeManager = new ExchangeManager(
        this.getExchanges(),
        this.getLogger(),
        this.getInstances(),
        this.getConfig()
      );
    }

    return exchangeManager;
  },

  getOrderExecutor: function() {
    if (!orderExecutor) {
      orderExecutor = new OrderExecutor(
        this.getExchangeManager(),
        this.getTickers(),
        this.getSystemUtil(),
        this.getLogger()
      );
    }

    return orderExecutor;
  },

  getOrderCalculator: function() {
    if (!orderCalculator) {
      orderCalculator = new OrderCalculator(
        this.getTickers(),
        this.getLogger(),
        this.getExchangeManager(),
        this.getPairConfig()
      );
    }

    return orderCalculator;
  },

  getHttpPairs: function() {
    if (!pairsHttp) {
      pairsHttp = new PairsHttp(
        this.getInstances(),
        this.getExchangeManager(),
        this.getPairStateManager(),
        this.getEventEmitter()
      );
    }

    return pairsHttp;
  },

  getPairConfig: function() {
    if (!pairConfig) {
      pairConfig = new PairConfig(this.getInstances());
    }

    return pairConfig;
  },

  getPairStateManager: function() {
    if (!pairStateManager) {
      pairStateManager = new PairStateManager(
        this.getLogger(),
        this.getPairConfig(),
        this.getSystemUtil(),
        this.getPairStateExecution(),
        this.getOrderExecutor()
      );
    }

    return pairStateManager;
  },

  getPairStateExecution: function() {
    if (!pairStateExecution) {
      pairStateExecution = new PairStateExecution(
        this.getExchangeManager(),
        this.getOrderCalculator(),
        this.getOrderExecutor(),
        this.getLogger(),
        this.getTickers()
      );
    }

    return pairStateExecution;
  },

  getSystemUtil: function() {
    if (!systemUtil) {
      systemUtil = new SystemUtil(this.getConfig());
    }

    return systemUtil;
  },

  getTechnicalAnalysisValidator: function() {
    if (!technicalAnalysisValidator) {
      technicalAnalysisValidator = new TechnicalAnalysisValidator();
    }

    return technicalAnalysisValidator;
  },

  getLogsRepository: function() {
    if (!logsRepository) {
      logsRepository = new LogsRepository(this.getDatabase());
    }

    return logsRepository;
  },

  getLogsHttp: function() {
    if (!logsHttp) {
      logsHttp = new LogsHttp(this.getLogsRepository());
    }

    return logsHttp;
  },

  getTickerLogRepository: function() {
    if (!tickerLogRepository) {
      tickerLogRepository = new TickerLogRepository(this.getDatabase());
    }

    return tickerLogRepository;
  },

  getTickerRepository: function() {
    if (!tickerRepository) {
      tickerRepository = new TickerRepository(this.getDatabase(), this.getLogger());
    }

    return tickerRepository;
  },

  getCandlestickResample: function() {
    if (!candlestickResample) {
      candlestickResample = new CandlestickResample(this.getCandlestickRepository(), this.getCandleImporter());
    }

    return candlestickResample;
  },

  getRequestClient: function() {
    if (!requestClient) {
      requestClient = new RequestClient(this.getLogger());
    }

    return requestClient;
  },

  getQueue: function() {
    if (!queue) {
      queue = new Queue();
    }

    return queue;
  },

  getCandleExportHttp: function() {
    if (!candleExportHttp) {
      candleExportHttp = new CandleExportHttp(this.getCandlestickRepository(), this.getPairConfig());
    }

    return candleExportHttp;
  },

  getOrdersHttp: function() {
    if (!ordersHttp) {
      ordersHttp = new OrdersHttp(
        this.getBacktest(),
        this.getTickers(),
        this.getOrderExecutor(),
        this.getExchangeManager(),
        this.getPairConfig()
      );
    }

    return ordersHttp;
  },

  getExchangeCandleCombine: function() {
    if (!exchangeCandleCombine) {
      exchangeCandleCombine = new ExchangeCandleCombine(this.getCandlestickRepository());
    }

    return exchangeCandleCombine;
  },

  getExchangePositionWatcher: function() {
    if (!exchangePositionWatcher) {
      exchangePositionWatcher = new ExchangePositionWatcher(
        this.getExchangeManager(),
        this.getEventEmitter(),
        this.getLogger()
      );
    }

    return exchangePositionWatcher;
  },

  getThrottler: function() {
    if (!throttler) {
      throttler = new Throttler(this.getLogger());
    }

    return throttler;
  },

  getExchanges: function() {
    if (!exchanges) {
      exchanges = [
        new Bitmex(
          this.getEventEmitter(),
          this.getRequestClient(),
          this.getCandlestickResample(),
          this.getLogger(),
          this.getQueue(),
          this.getCandleImporter()
        ),
        new BitmexTestnet(
          this.getEventEmitter(),
          this.getRequestClient(),
          this.getCandlestickResample(),
          this.getLogger(),
          this.getQueue(),
          this.getCandleImporter()
        ),
        new Binance(
          this.getEventEmitter(),
          this.getLogger(),
          this.getQueue(),
          this.getCandleImporter(),
          this.getThrottler()
        ),
        new CoinbasePro(
          this.getEventEmitter(),
          this.getLogger(),
          this.getCandlestickResample(),
          this.getQueue(),
          this.getCandleImporter()
        ),
        new Bitfinex(this.getEventEmitter(), this.getLogger(), this.getRequestClient(), this.getCandleImporter()),
        new Bybit(
          this.getEventEmitter(),
          this.getRequestClient(),
          this.getCandlestickResample(),
          this.getLogger(),
          this.getQueue(),
          this.getCandleImporter(),
          this.getThrottler()
        ),
        new FTX(
          this.getEventEmitter(),
          this.getRequestClient(),
          this.getCandlestickResample(),
          this.getLogger(),
          this.getQueue(),
          this.getCandleImporter()
        ),
        new BinanceFutures(
          this.getEventEmitter(),
          this.getRequestClient(),
          this.getCandlestickResample(),
          this.getLogger(),
          this.getQueue(),
          this.getCandleImporter(),
          this.getThrottler()
        ),
        new BinanceMargin(
          this.getEventEmitter(),
          this.getLogger(),
          this.getQueue(),
          this.getCandleImporter(),
          this.getThrottler()
        ),
        new Noop()
      ];
    }

    return exchanges;
  },

  createTradeInstance: function() {
    this.getExchangeManager().init();

    return new Trade(
      this.getEventEmitter(),
      this.getInstances(),
      this.getNotifier(),
      this.getLogger(),
      this.getCreateOrderListener(),
      this.getTickListener(),
      this.getTickers(),
      this.getTickerDatabaseListener(),
      this.getExchangeOrderWatchdogListener(),
      this.getSystemUtil(),
      this.getLogsRepository(),
      this.getTickerLogRepository(),
      this.getExchangePositionWatcher(),
      this.getPairStateManager()
    );
  },

  getBackfill: function() {
    return new Backfill(this.getExchanges(), this.getCandleImporter());
  },

  createMailer: function() {
    // eslint-disable-next-line global-require
    const mail = require('nodemailer');

    const configuration = this.getConfig();

    return mail.createTransport(
      `smtps://${configuration.notify.mail.username}:${configuration.notify.mail.password}@${
        configuration.notify.mail.server
      }:${configuration.notify.mail.password || 465}`,
      {
        from: configuration.notify.mail.username
      }
    );
  },

  createTelegram: function() {
    // eslint-disable-next-line global-require
    const Telegraf = require('telegraf');
    const configuration = this.getConfig();
    const { token } = configuration.notify.telegram;

    if (!token) {
      console.log('Telegram: No api token given');
      return null;
    }

    return new Telegraf(token);
  },

  getInstances: () => {
    return instances;
  },

  getConfig: () => {
    return config;
  }
};
