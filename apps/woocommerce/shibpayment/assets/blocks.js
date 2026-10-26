/* "Pay with SHIB" in the block checkout. Paying happens on the next page, so this only shows the option. */
(function () {
  var registry = window.wc && window.wc.wcBlocksRegistry;
  if (!registry) return;
  var settings = window.wc.wcSettings.getSetting('shibpay_data', {});
  var el = window.wp.element.createElement;
  var decode = window.wp.htmlEntities.decodeEntities;
  var title = decode(settings.title || 'Pay with SHIB');

  var Label = function () {
    return el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
      el('img', { src: settings.logo, alt: '', width: 24, height: 24, style: { borderRadius: '50%' } }),
      title);
  };
  var Content = function () {
    return el('p', null, decode(settings.description || ''));
  };

  registry.registerPaymentMethod({
    name: 'shibpay',
    label: el(Label),
    content: el(Content),
    edit: el(Content),
    canMakePayment: function () { return true; },
    ariaLabel: title,
    supports: { features: settings.supports || ['products'] },
  });
})();
