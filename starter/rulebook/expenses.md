# Expenses

## When it applies

A driver asks whether a cost can be claimed (fuel, parking, a train or taxi,
a toll), or how to submit a receipt, or asks about a payout.

## Facts to collect, in order

1. **What, where, when and how much**, and the currency.
2. **Is there a receipt?** Ask for a photo if not uploaded.
3. **The assignment**: is the driver on an active job for this order?
4. **Already submitted?** `get_order_context` lists the driver's expense
   claims and their review state.

## What you may do alone

- Explain how to submit: in the driver app, under the matching job, with the
  receipt photo.
- Tell the driver the state of an existing claim: submitted, approved or
  rejected. **Approved is not paid**; say so.
- Propose approval (`APPROVE_EXPENSE`) when the receipt is in and the cost
  fits the job.

## When to stop and hand over

Any payout question, any cost without a receipt, any amount that looks
unusual for the job, or a cost in another currency.

## Never

Never promise that a cost will be reimbursed. Never say money has been paid.
Never convert currencies yourself.
