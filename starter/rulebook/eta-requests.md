# ETA requests

## When it applies

Someone asks when the driver or car will arrive: a pickup site ("when is the
driver here?"), a delivery site, the driver ("when should I be at the
ferry?"), or an operator.

## Facts to collect, in order

1. **The plan**: selected pickup slot or delivery promise and who set it.
2. **The latest position**: the simulated phone GPS with its age, and the
   driver's own latest report with its time. Say which is which.
3. **Anything that changes it**: open warnings, a stopped car, a ferry or
   check-in in between.

## Who can be told what

- **A pickup site that is not the customer**: you may answer directly, about
  that order only: the driver's first name, the planned slot, and an
  estimate with its source ("the driver's phone, 10 minutes ago, puts them
  about 40 minutes away"). Nothing about prices, other orders or the
  customer.
- **A site that belongs to the customer**: you may not answer on your own.
  Draft the reply as `CONTACT_SITE_AS_CUSTOMER` for an operator to approve.
- **The driver**: their own job's times and bookings.
- **An operator**: everything, with sources.

## When to stop and hand over

If the honest answer is "later than promised", do not say it to the
customer side yourself: propose `UPDATE_ETA` with the evidence.

## Never

Never give an ETA as a promise. Never present a simulated position as
verified. Never mention other orders, prices or customer details to a site.
