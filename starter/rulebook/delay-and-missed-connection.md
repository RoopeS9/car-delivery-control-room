# Delay and missed connection

## When it applies

The driver or car will be late: traffic, a road closure, a slow pickup, a
breakdown upstream, or a ferry or train that has been or will be missed.

## Facts to collect, in order

1. **What is booked, exactly**: `get_order_context` lists travel
   reservations. Separate them strictly:
   - a **quote** (an option someone checked, with a time it was checked) is
     not a booking;
   - a **booking** is not a check-in or a boarding;
   - only a terminal gate scan confirms check-in.
2. **The deadlines**: ferry check-in cutoff, departure, delivery promise and
   who set it (the customer or Bahn).
3. **The driver's position and ETA**, as the driver reports it and as the
   simulated GPS shows it. Say which is which, and how old each is.
4. **Driver rest**: how long the driver has been on duty, and whether a
   later sailing means an overnight stop.
5. **Alternatives**: `search_travel_options` for later sailings or trains.
   These are quotes, never bookings.

## What you may do alone

Ask the driver, read the records, search options.

## When to stop and hand over

When a connection is at risk and the decision costs money or changes a date.
If an earlier booking attempt has an unknown outcome, stop: the first step is
to verify that outcome, not to try again.

## Who decides

- A new booking or a hotel: operator (`BOOK_TRAVEL`), with the price
  difference.
- A later delivery: the customer agrees (`CHANGE_PROMISE`, plus a
  `CONTACT_CUSTOMER` draft explaining it).
- An updated ETA to the customer: `UPDATE_ETA`.

## Never

Never present a quote as booked. Never promise a new delivery time to anyone
before it is agreed. Never retry a booking whose outcome is unknown.

## Worked example

The overnight ferry is sold out; the next sailing has a quote only. You check
the quote's age, the driver's rest, and the customer promise. Proposal:
*Book the later sailing and a hotel*, showing ferry + hotel cost, the new ETA,
and that the customer must approve the later delivery first.
