import { loadConfig } from '@jw/config';
import { createShippingProvider } from '@jw/integrations';
// This command never creates an order, AWB, pickup or label and never prints credentials.
const config = loadConfig();
const provider = createShippingProvider(config);
if (!provider) {
  console.log('Shiprocket activation deferred. Manual fulfilment remains available. No provider contacted.');
} else {
  const [pickups, wallet] = await Promise.all([
    provider.listPickupLocations(),
    provider.walletBalancePaise(),
  ]);
  console.log(
    JSON.stringify({
      provider: provider.name,
      connection: 'reachable',
      pickupLocations: pickups,
      walletBalancePaise: wallet,
      bookingPerformed: false,
    }),
  );
  if (!pickups.length) {
    console.error('Add a pickup location in the provider account before dispatch.');
    process.exitCode = 1;
  }
}
