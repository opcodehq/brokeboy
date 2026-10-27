import { defineCatalog } from "../src/index.js";
export const catalog = defineCatalog({
  features: [
    { id: "credits", kind: "consumable" },
    { id: "messages", kind: "consumable" },
    { id: "sso", kind: "boolean" },
    { id: "seats", kind: "quantity" },
  ],
  plans: [
    {
      id: "free",
      name: "Free",
      kind: "free",
      items: [
        { feature: "credits", included: "100", reset: "month" },
        { feature: "messages", pool: "credits", rate: { amount: "1" } },
      ],
    },
    {
      id: "pro",
      name: "Pro",
      currency: "usd",
      amount: "20",
      interval: "month",
      trialDays: 7,
      trialIncluded: { credits: "50" },
      items: [
        {
          feature: "credits",
          included: "2000",
          reset: "month",
          rollover: { maximum: "500", periods: 1 },
        },
        { feature: "messages", pool: "credits", rate: { amount: "1" } },
        { feature: "sso", enabled: true },
        { feature: "seats", included: "5" },
      ],
    },
    {
      id: "credits-1000",
      name: "1,000 credits",
      kind: "one_time",
      currency: "usd",
      amount: "10",
      items: [{ feature: "credits", included: "1000" }],
    },
    {
      id: "metered",
      name: "Usage",
      currency: "usd",
      amount: "5",
      interval: "month",
      items: [
        {
          feature: "messages",
          included: "100",
          overage: true,
          rate: {
            mode: "graduated",
            tiers: [
              { upTo: "1000", amount: "0.01" },
              { upTo: null, amount: "0.005" },
            ],
          },
        },
      ],
    },
  ],
});
