/* ShibPayment for WooCommerce: hands the button's payment to the shop, which checks it on-chain. */
(function () {
  var cfg = window.shibpayCheckout;
  if (!cfg) return;
  var status = document.querySelector('.shibpay-status');
  var button = document.querySelector('shib-pay');
  var watching = false;

  function say(text) {
    if (status) status.textContent = text || '';
  }

  function call(path, body) {
    var q = 'order=' + encodeURIComponent(cfg.order) + '&key=' + encodeURIComponent(cfg.key);
    var init = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ order: cfg.order, key: cfg.key }, body)) }
      : { method: 'GET' };
    return fetch(cfg.api + path + (body ? '' : '?' + q), init).then(function (r) {
      if (!r.ok && r.status !== 400) throw new Error(String(r.status));
      return r.json();
    });
  }

  function show(res) {
    if (!res || !res.status) return say(cfg.text.error);
    say(res.message);
    if (res.status === 'paid' || res.status === 'review') {
      if (cfg.doneUrl) location.href = cfg.doneUrl;
      else if (document.querySelector('[data-watch]')) location.reload();
      return;
    }
    if (res.status === 'confirming') watch();
  }

  function watch() {
    if (watching) return;
    watching = true;
    var tries = 0;
    (function next() {
      setTimeout(function () {
        call('status')
          .then(function (res) {
            if (res.status === 'confirming' && ++tries < 240) return next();
            watching = false;
            show(res);
          })
          .catch(next);
      }, 5000);
    })();
  }

  function confirm(body) {
    say(cfg.text.checking);
    return call('confirm', body).then(show).catch(function () { say(cfg.text.error); });
  }

  if (button) {
    // The buyer just chose to pay with SHIB: open the checkout straight away.
    customElements.whenDefined('shib-pay').then(function () { button.show(); });
    button.addEventListener('shibpay:paid', function (e) {
      // Stay on this page until the shop has checked the payment.
      button.removeAttribute('return-url');
      confirm({ tx: e.detail.txHash, chain: e.detail.chainId, token: e.detail.token });
    });
  }

  var form = document.querySelector('.shibpay-paste-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      confirm({ tx: form.elements.tx.value });
    });
  }

  if (document.querySelector('[data-watch]')) watch();
})();
