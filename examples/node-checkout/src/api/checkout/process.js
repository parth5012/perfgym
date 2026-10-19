export async function processItem(item) {
  return { id: item.id, price: item.price * 1.1, valid: true };
}

export async function processCheckout(cart) {
  // Optimized concurrent processing with Promise.all
  const results = await Promise.all(cart.items.map(processItem));
  const total = results.reduce((acc, r) => acc + r.price, 0);
  return { total, count: results.length };
}
