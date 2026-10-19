import { processCheckout } from "../src/api/checkout/process.js";
import { performance } from "node:perf_hooks";

const cart = {
  items: Array.from({ length: 50 }, (_, i) => ({ id: `item-${i}`, price: (i + 1) * 2 })),
};

// Warmup
for (let i = 0; i < 5; i++) {
  await processCheckout(cart);
}

// Measurement
const start = performance.now();
for (let i = 0; i < 50; i++) {
  await processCheckout(cart);
}
const elapsed = performance.now() - start;

console.log(JSON.stringify({ value: parseFloat(elapsed.toFixed(2)) }));
