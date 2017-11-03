require('dotenv-extended').load();
const restify = require('restify');
const builder = require('botbuilder');

const greeting = require('./app/recognizer/greeting');
const commands = require('./app/recognizer/commands');
const smiles = require('./app/recognizer/smiles')
var payments = require('./payments');
var checkout = require('./checkout');
var catalog = require('./services/catalog');


const dialog = {
    welcome: require('./app/dialogs/welcome'),
    categories: require('./app/dialogs/categories'),
    explore: require('./app/dialogs/explore'),
    showProduct: require('./app/dialogs/showProduct'),
    choseVariant: require('./app/dialogs/choseVariant'),
    showVariant: require('./app/dialogs/showVariant'),
    addToCart: require('./app/dialogs/addToCart'),
    showCart: require('./app/dialogs/showCart')
};

const connector = new builder.ChatConnector({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSFT_APP_PASSWORD
});

var CartIdKey = 'CardId';

const bot = new builder.UniversalBot(connector, {
    persistConversationData: true
});

connector.onInvoke((invoke, callback) => {
    console.log('onInvoke', invoke);
  
    // This is a temporary workaround for the issue that the channelId for "webchat" is mapped to "directline" in the incoming RelatesTo object
    invoke.relatesTo.channelId = invoke.relatesTo.channelId === 'directline' ? 'webchat' : invoke.relatesTo.channelId;
  
    var storageCtx = {
      address: invoke.relatesTo,
      persistConversationData: true,
      conversationId: invoke.relatesTo.conversation.id
    };
  
    connector.getData(storageCtx, (err, data) => {
      var cartId = data.conversationData[CartIdKey];
      if (!invoke.relatesTo.user && cartId) {
        // Bot keeps the userId in context.ConversationData[cartId]
        var userId = data.conversationData[cartId];
        invoke.relatesTo.useAuth = true;
        invoke.relatesTo.user = { id: userId };
      }
  
      // Continue based on PaymentRequest event
      var paymentRequest = null;
      switch (invoke.name) {
        case payments.Operations.UpdateShippingAddressOperation:
        case payments.Operations.UpdateShippingOptionOperation:
          paymentRequest = invoke.value;
  
          // Validate address AND shipping method (if selected)
          checkout
            .validateAndCalculateDetails(paymentRequest, paymentRequest.shippingAddress, paymentRequest.shippingOption)
            .then(updatedPaymentRequest => {
              // return new paymentRequest with updated details
              callback(null, updatedPaymentRequest, 200);
            }).catch(err => {
              // return error to onInvoke handler
              callback(err);
              // send error message back to user
              bot.beginDialog(invoke.relatesTo, 'checkout_failed', {
                errorMessage: err.message
              });
            });
  
          break;
  
        case payments.Operations.PaymentCompleteOperation:
          var paymentRequestComplete = invoke.value;
          paymentRequest = paymentRequestComplete.paymentRequest;
          var paymentResponse = paymentRequestComplete.paymentResponse;
  
          // Validate address AND shipping method
          checkout
            .validateAndCalculateDetails(paymentRequest, paymentResponse.shippingAddress, paymentResponse.shippingOption)
            .then(updatedPaymentRequest =>
              // Process Payment
              checkout
                .processPayment(updatedPaymentRequest, paymentResponse)
                .then(chargeResult => {
                  // return success
                  callback(null, { result: "success" }, 200);
                  // send receipt to user
                  bot.beginDialog(invoke.relatesTo, 'checkout_receipt', {
                    paymentRequest: updatedPaymentRequest,
                    chargeResult: chargeResult
                  });
                })
            ).catch(err => {
              // return error to onInvoke handler
              callback(err);
              // send error message back to user
              bot.beginDialog(invoke.relatesTo, 'checkout_failed', {
                errorMessage: err.message
              });
            });
  
          break;
      }
  
    });
  });
  
  bot.dialog('checkout_receipt', function (session, args) {
    console.log('checkout_receipt', args);
  
    cleanupConversationData(session);
  
    var paymentRequest = args.paymentRequest;
    var chargeResult = args.chargeResult;
    var shippingAddress = chargeResult.shippingAddress;
    var shippingOption = chargeResult.shippingOption;
    var orderId = chargeResult.orderId;
  
    // send receipt card
    var items = paymentRequest.details.displayItems
      .map(o => builder.ReceiptItem.create(session, o.amount.currency + ' ' + o.amount.value, o.label));
  
    var receiptCard = new builder.ReceiptCard(session)
      .title('Contoso Order Receipt')
      .facts([
        builder.Fact.create(session, orderId, 'Order ID'),
        builder.Fact.create(session, chargeResult.methodName, 'Payment Method'),
        builder.Fact.create(session, [shippingAddress.addressLine, shippingAddress.city, shippingAddress.region, shippingAddress.country].join(', '), 'Shipping Address'),
        builder.Fact.create(session, shippingOption, 'Shipping Option')
      ])
      .items(items)
      .total(paymentRequest.details.total.amount.currency + ' ' + paymentRequest.details.total.amount.value);
  
    session.endDialog(
      new builder.Message(session)
        .addAttachment(receiptCard));
  });
  
  bot.dialog('checkout_failed', function (session, args) {
    cleanupConversationData(session);
    session.endDialog('Could not process your payment: %s', args.errorMessage);
  });
  
  // PaymentRequest with default options
  function createPaymentRequest(cartId, product) {
    if (!cartId) {
      throw new Error('cartId is missing');
    }
  
    if (!product) {
      throw new Error('product is missing');
    }
  
    // PaymentMethodData[]
    var paymentMethods = [{
      supportedMethods: [payments.MicrosoftPayMethodName],
      data: {
        mode: process.env.PAYMENTS_LIVEMODE === 'true' ? null : 'TEST',
        merchantId: process.env.PAYMENTS_MERCHANT_ID,
        supportedNetworks: ['visa', 'mastercard'],
        supportedTypes: ['credit']
      }
    }];
  
    // PaymentDetails
    var paymentDetails = {
      total: {
        label: 'Total',
        amount: { currency: product.currency, value: product.price.toFixed(2) },
        pending: true
      },
      displayItems: [
        {
          label: product.name,
          amount: { currency: product.currency, value: product.price.toFixed(2) }
        }, {
          label: 'Shipping',
          amount: { currency: product.currency, value: '0.00' },
          pending: true
        }, {
          label: 'Sales Tax',
          amount: { currency: product.currency, value: '0.00' },
          pending: true
        }],
      // until a shipping address is selected, we can't offer shipping options or calculate taxes or shipping costs
      shippingOptions: []
    };
  
    // PaymentOptions
    var paymentOptions = {
      requestPayerName: true,
      requestPayerEmail: true,
      requestPayerPhone: true,
      requestShipping: true,
      shippingType: 'shipping'
    };
  
    // PaymentRequest
    return {
      id: cartId,
      expires: '1.00:00:00',          // 1 day
      methodData: paymentMethods,     // paymethodMethods: paymentMethods,
      details: paymentDetails,        // paymentDetails: paymentDetails,
      options: paymentOptions         // paymentOptions: paymentOptions
    };
  }
  
  function cleanupConversationData(session) {
    var cartId = session.conversationData[CartIdKey];
    delete session.conversationData[CartIdKey];
    delete session.conversationData[cartId];
  } 



var intents = new builder.IntentDialog({
    recognizers: [
        commands,
        greeting,
        new builder.LuisRecognizer(process.env.LUIS_ENDPOINT)
    ],
    intentThreshold: 0.2,
    recognizeOrder: builder.RecognizeOrder.series
});

intents.matches('Greeting', '/welcome');
intents.matches('ShowTopCategories', '/categories');
intents.matches('Explore', '/explore');
intents.matches('Next', '/next');
intents.matches('ShowProduct', '/showProduct');
intents.matches('AddToCart', '/addToCart');
intents.matches('ShowCart', '/showCart');
intents.matches('Checkout', '/checkout');
intents.matches('Reset', '/reset');
intents.matches('Smile', '/smileBack');
intents.onDefault('/confused');

bot.dialog('/', intents);
dialog.welcome(bot);
dialog.categories(bot);
dialog.explore(bot);
dialog.showProduct(bot);
dialog.choseVariant(bot);
dialog.showVariant(bot);
dialog.addToCart(bot);
dialog.showCart(bot);

bot.dialog('/confused', [
    function (session, args, next) {
        // ToDo: need to offer an option to say "help"
        if (session.message.text.trim()) {
            session.endDialog('Sorry, I didn\'t understand you or maybe just lost track of our conversation');
        } else {
            session.endDialog();
        }        
    }
]);

bot.on('routing', smiles.smileBack.bind(smiles));

bot.dialog('/reset', [
    function (session, args, next) {
        session.endConversation(['See you later!', 'bye!']);
    }
]);

// bot.dialog('/checkout', [
//     function (session, args, next) {
//         const cart = session.privateConversationData.cart;

//         if (!cart || !cart.length) {
//             session.send('I would be happy to check you out but your cart appears to be empty. Look around and see if you like anything');
//             session.reset('/categories');
//         } else {
//             session.endDialog('Alright! You are all set!');
//         }
//     }
// ]);

const server = restify.createServer();
server.listen(process.env.port || process.env.PORT || 3978, function () {
    console.log('%s listening to %s', server.name, server.url);
});
server.get(/.*/, restify.serveStatic({
    'directory': '.',
    'default': 'index.html'
}));
server.post('/api/messages', connector.listen());


