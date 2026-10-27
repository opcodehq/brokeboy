import { createRoot } from "react-dom/client";
import {
  BillingProvider,
  CreditBalance,
  CustomerPortalButton,
  createBillingClient,
  PricingTable,
  SpendingControls,
  SubscriptionDetails,
  UsageHistory,
} from "../../src/react/index.js";

const client = createBillingClient();
function Demo() {
  return (
    <BillingProvider client={client}>
      <main>
        <p>LOCAL SDK DEMO</p>
        <h1>Billing in your application.</h1>
        <p>
          This demo uses an ephemeral local database. No payments are taken.
        </p>
        <section aria-label="Account">
          <h2>Account</h2>
          <CreditBalance feature="credits" />
          <SubscriptionDetails />
          <CustomerPortalButton returnUrl="http://127.0.0.1:32109/" />
        </section>
        <SpendingControls />
        <PricingTable successUrl="http://127.0.0.1:32109/" />
        <UsageHistory />
      </main>
    </BillingProvider>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Demo />);
