# qzu-Access

- EUR 19.99 including 19% tax, first five months included; EUR 2.99 per additional month including 19% tax.
- No Litecoin node, exchange-rate API or automatic transaction detection is required.
- The QR contains the fixed public Litecoin receiving address only. The customer enters the EUR equivalent in their wallet, sends the payment, then submits the transaction ID.
- The 30-minute review countdown begins on submission. Expiration never grants access. Approval may arrive sooner or later. Keep the private QZO order reference to resume.
- Inspect your own wallet and verify the destination, amount, exchange rate, confirmations and that the transaction is not already used before approval. A public transaction ID alone is not proof of payer ownership; resolve disputes manually. There is no automatic conversion, refund, payment verification or recurring debit.
- Run npm run access-invoices to list orders and submitted transaction IDs. Run npm run access-approve -- INVOICE_ID only after verifying funds. Run npm run access-reject -- INVOICE_ID to reject an invalid submission.
- Approval generates a separate random single-use QZU activation key that the customer retrieves on the waiting screen. Never send an order reference or activation key to someone you do not trust.
- The private developer socket is the only approval interface. The external admin website is not implemented.
- Existing accounts and previously confirmed keys remain valid. Old unconfirmed automatic-checkout orders may require manual reconciliation by the developer.
- The optional QZU_PAYMENT_WEBHOOK sends a notification after approval. Existing feedback and reset webhooks remain unchanged.
- npm run access-create -- 1 creates a complimentary lifetime key.
- Keep .env and the SQLite database private. The existing account design does not recover accounts after losing the browser cookie. Test before accepting payments.
