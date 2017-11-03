const builder = require('botbuilder');
const sentiment = require('../sentiment');
const payments = require('../../payments');
const checkout = require('../../checkout');
const catalog = require('../../services/catalog');

var CartIdKey = 'CardId';

const displayCart = function(session, cart) {

    catalog.getPromotedItem().then(product => {
        
            // Store userId for later, when reading relatedTo to resume dialog with the receipt
            var cartId = product.id;
            session.conversationData[CartIdKey] = cartId;
            session.conversationData[cartId] = session.message.address.user.id;
        
            // Create PaymentRequest obj based on product information
            var paymentRequest = createPaymentRequest(cartId, product);

            const cards = cart.map(item => new builder.ThumbnailCard(session)
                .title(item.product.title)
                .subtitle(`$${item.variant.price}`)
                .text(`${item.variant.color ? 'Color -' + item.variant.color + '\n' : ''}` +
                    `${item.variant.size ? 'Size -' + item.variant.size : ''}` || item.product.description)
                .buttons([builder.CardAction.imBack(session, `@remove:${item.variant.id}`, 'Remove'),
                new builder.CardAction(session)
                .title('Checkout')
                .type(payments.PaymentActionType)
                .value(paymentRequest)])
                .images([
                    builder.CardImage.create(session, `https://${item.variant.image_domain}${item.variant.image_suffix}`)
                ])
            );
        
            session.sendTyping();
            session.send(new builder.Message(session, `You have ${cart.length} products in your cart`)
                .attachments(cards)
                .attachmentLayout(builder.AttachmentLayout.carousel));
    });
};

module.exports = function (bot) {
    bot.dialog('/showCart', [
        function (session, args, next) {
            const cart = session.privateConversationData.cart;

            if (!cart || !cart.length) {
                session.send('Your shopping cart appears to be empty. Can I help you find anything?');
                session.reset('/categories');
            } else {
                displayCart(session, cart);
                next();
            }
        },
        ...sentiment.confirm('Ready to checkout?'),
        function(session, args, next) {
            if (args.response) {
                session.reset('/checkout');
            } else {
                session.endDialog('Sure, take your time. Just tell me when');
            }
        }
    ])
};

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
  