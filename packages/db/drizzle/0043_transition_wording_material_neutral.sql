-- The one transition description that named a material.
--
-- `order_status_transitions.description_th` is read by staff, not by code: it is the
-- dialog title in `order-detail.tsx` and the button label on the order spine. One row
-- said `โรงงานเริ่มตัดอะลูมิเนียม` — "the factory starts cutting aluminium".
--
-- Two things are wrong with it and only the second is about wording.
--
-- The catalogue is 81 products in ten categories, and four of them are
-- `มุ้งกันยุงและแมลง` — insect screens. Twenty-four are `ระแนงและป้องกันแสงแดด`. A staff
-- member pressing this button on a screen order reads a sentence about an operation that
-- is not happening. The company makes aluminium joinery, so the phrase was true of the
-- common case and the row was written from it.
--
-- The deeper one: this transition is the production commitment, and what the business
-- needs from it is *that* rather than the physical act. `orders.frozen_at` is set here and
-- survives a later cancellation precisely so a forfeit can be computed against it — see
-- `order_status_is_post_freeze()` and `packages/contract/src/order.ts`, which explains why
-- `cancelled` and `superseded` are absent from the post-freeze list. Naming the act ties
-- the label to one product line; naming the commitment holds for all ten.
--
-- Left alone, deliberately: every other mention of อะลูมิเนียม in this product. The
-- storefront's own description of what the company makes, the `spec.material.value` of an
-- extruded product, and the example option-group name in the dashboard are all about
-- aluminium and are all correct.
UPDATE "order_status_transitions"
SET "description_th" = 'โรงงานเริ่มผลิต'
WHERE "from_status" = 'production_confirmed'
  AND "to_status" = 'in_production'
  AND "description_th" = 'โรงงานเริ่มตัดอะลูมิเนียม';
