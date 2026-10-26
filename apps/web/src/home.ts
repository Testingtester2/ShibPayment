import '@shibpay/button';

// The hero card's button opens a demo checkout: the full flow, no wallet, nothing sent.
document.getElementById('tryDemo')!.addEventListener('click', () => {
  (document.getElementById('demo') as unknown as { show(): void }).show();
});
