-- Evaluations record the call they score. Until now a new evaluation always
-- stored the transfer's closer leg, even for fronter (TRA) forms; point each
-- one at the leg its form reviews. Only call_id changes — no score, answer
-- or status — and reports already credit the agent by the form's target.
UPDATE "evaluations" e
   SET "call_id" = t."fronter_call_id"
  FROM "transfers" t, "qa_form_versions" v, "qa_forms" f
 WHERE t."id" = e."transfer_id" AND v."id" = e."form_version_id" AND f."id" = v."form_id"
   AND f."target" = 'fronter'
   AND t."fronter_call_id" IS NOT NULL
   AND e."call_id" IS DISTINCT FROM t."fronter_call_id";
--> statement-breakpoint
UPDATE "evaluations" e
   SET "call_id" = t."closer_call_id"
  FROM "transfers" t, "qa_form_versions" v, "qa_forms" f
 WHERE t."id" = e."transfer_id" AND v."id" = e."form_version_id" AND f."id" = v."form_id"
   AND f."target" = 'closer'
   AND t."closer_call_id" IS NOT NULL
   AND e."call_id" IS DISTINCT FROM t."closer_call_id"
   AND e."call_id" IS DISTINCT FROM t."sale_call_id";
