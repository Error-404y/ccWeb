# qzu-Access

- Initial access: EUR 19.99 including 19% tax, first five months included.
- Renewal: EUR 2.99 including 19% tax per additional month.
- Initial twelve-month price: EUR 40.92. Renewals are manual; the software does not collect debts or automatically debit a wallet.
- Existing accounts are grandfathered. Complimentary developer keys grant lifetime access.
- Checkout uses the configured fixed Litecoin address, unique exact amounts, and three confirmations. This is not a unique address per invoice. Wrong amounts, overpayments and late payments require manual reconciliation. Do not accept real funds before testing the full flow.
- Use a dedicated synced Litecoin Core mainnet watch-only wallet containing the receiving address. Disable private keys in the wallet; keep RPC bound to localhost. Never put a private key or recovery phrase on the web server.
- Configure .env using .env.example. A CoinGecko Demo API key is required for EUR quotes. A separate Discord webhook enables payment notifications.
- New account creation is gated by default. Without RPC and exchange-rate credentials, checkout fails closed; developer-issued keys still work.
- Paid users should keep the access key private until redemption, and keep their account browser cookie after redemption. Clearing that cookie loses access under the existing account design.
- Start the server, then run npm run access-create -- 1 for a complimentary test key, npm run access-invoices for invoice status, or npm run access-review -- INVOICE_ID to approve a verified late payment with at least three confirmations.
- Tax display is configurable business information, not an assessment of tax registration or reporting obligations.
- End-to-end encryption is not included in this release.
