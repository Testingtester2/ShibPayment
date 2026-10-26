import shibLogo from './assets/shib-logo-128.png';

export { shibLogo };

/** Token logos. SHIB ships inside the bundle; the others come from CoinGecko, as in ShibWallet. */
export const TOKEN_LOGOS: Record<string, string> = {
  SHIB: shibLogo,
  BONE: 'https://assets.coingecko.com/coins/images/16916/large/bone_icon.png',
  LEASH: 'https://assets.coingecko.com/coins/images/15802/large/Leash.png',
  TREAT: 'https://assets.coingecko.com/coins/images/53501/large/Treat_blk_200x200.png',
};

/**
 * TREAT's only published logo is the red mark on a white disc with "Treat"
 * written under it. Zoom in on the red mark so it matches the other tokens.
 */
export const TREAT_CROP = 'transform:translateY(10%) scale(1.85);transform-origin:50% 40%';

/** A token logo over a lettered circle, so a blocked image still reads as the token. */
export const tokenLogo = (symbol: string, size = 32) =>
  `<span class="tlogo" style="--tl:${size}px"><span>${symbol[0]}</span><img src="${TOKEN_LOGOS[symbol]}" alt="" onerror="this.remove()"${symbol === 'TREAT' ? ` style="${TREAT_CROP}"` : ''} /></span>`;

/** ShibPayment wordmark: SHIB logo, "Shib" in white, "Payment" in the orange gradient. */
export const wordmark = (size = 22) =>
  `<span class="wordmark" style="--wm:${size}px"><img src="${shibLogo}" alt="" /><span class="wm-text"><span class="wm-shib">Shib</span><span class="wm-pay">Payment</span></span></span>`;

export const FLAME = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2c.6 3.2-1.4 5-2.9 6.6C7.6 10.2 6 12 6 14.8 6 18.2 8.7 21 12 21s6-2.8 6-6.2c0-2.4-1.1-4.1-2.3-5.4-.2 1.6-1 2.8-2.2 3.3.4-3.8-.6-7.4-1.5-9.7z"/></svg>`;
export const CHECK = `<svg viewBox="0 0 52 52" width="64" height="64" aria-hidden="true"><circle cx="26" cy="26" r="24" fill="none" stroke="url(#g)" stroke-width="3"/><path d="M15 27l7 7 15-16" fill="none" stroke="url(#g)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#FF6900"/><stop offset="1" stop-color="#FFB800"/></linearGradient></defs></svg>`;
export const CLOSE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
export const PHONE = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 18.5h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
export const WALLET = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="3.5" y="7.5" width="17" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="16.5" cy="13.5" r="1.3" fill="currentColor"/></svg>`;
export const CHEVRON = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
