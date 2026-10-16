/** Prices are stored in minor units (halalas); 0 means the price hasn't been set yet. */
export const formatPrice = (minor: number) =>
  (minor / 100).toLocaleString('en-US', { style: 'currency', currency: 'SAR', maximumFractionDigits: 0 });
