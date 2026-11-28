# qzu-Access

## Current checkout

Direct-distribution builds offer fixed-term and lifetime access in USD. Checkout quotes the exact crypto amount for Litecoin, Bitcoin or Solana. Pay the quoted amount through the selected network, then add the transaction ID to the payment ticket. Save the private QZO order reference to reopen the order. Keep QZU activation keys private.

The server checks the transaction against the original quote and the network's confirmation requirement. Staff release the activation key from Control Center after verification. Orders that need attention appear under **Payments** and **Payment tickets**. An unmatched old submission remains available for review after automatic verification ends. Review the existing order before sending another payment.

Google Play builds accept existing activation keys. For an existing account with a timed plan, admins can extend access in Control Center when applicable.

## Legacy EUR orders

Existing EUR orders and previously confirmed keys retain their original terms. Use the saved QZO reference to recover an existing order. Verify the original payment in your wallet before manual approval. Check the destination, amount, confirmations and whether the transaction has already been credited.

- `npm run access-invoices` lists submitted orders.
- `npm run access-approve -- INVOICE_ID` approves a verified legacy EUR order.
- `npm run access-reject -- INVOICE_ID` rejects a submitted order.
- `npm run access-create -- 1` creates a complimentary lifetime key.

The optional `QZU_PAYMENT_WEBHOOK` sends a payment notification. Keep `.env`, the SQLite database and private backups in restricted storage.
