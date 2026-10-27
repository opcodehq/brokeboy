# Optional React toolkit

```tsx
import {
  BillingProvider,
  createBillingClient,
  PricingTable,
  CreditBalance,
  SubscriptionDetails,
  CustomerPortalButton,
  TopUpButton,
  UsageHistory,
  SpendingControls,
  AdminInspector,
} from "brokeboy/react";

const client = createBillingClient("/api/billing");

export function BillingSettings() {
  return (
    <BillingProvider client={client}>
      <CreditBalance feature="credits" />
      <SubscriptionDetails />
      <CustomerPortalButton returnUrl="https://your-app.example/settings" />
      <PricingTable successUrl="https://your-app.example/settings" />
      <TopUpButton
        planId="credits-1000"
        successUrl="https://your-app.example/settings"
      />
      <SpendingControls />
      <UsageHistory />
    </BillingProvider>
  );
}
```

Components are accessible, unstyled HTML intended to inherit your application's design. They use the same-origin handler and cannot write credit balances directly. Public catalog responses exclude rate internals and private plans. Configure trusted return origins on the server.

Hooks: `useBilling`, `useBillingResource`, `useBalance`, `useSubscriptions`, `useUsage`, and `useBillingAction`. Resource requests abort on unmount or parameter changes; `refresh` invalidates the resource. Actions return the operation status instead of assuming a payment completed.

Mount `AdminInspector` only in an administrative application surface and provide `authorizeAdmin` on the server. The inspector shows customer, grant, ledger-reconciliation and operation state. Admin routes additionally support audited credit adjustments and operation retries. A hidden component is not an authorization boundary.
