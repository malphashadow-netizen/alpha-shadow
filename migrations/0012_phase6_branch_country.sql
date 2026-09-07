-- EXPAND ONLY. Stop the migration runner here, manually map EVERY existing
-- branch to a verified jurisdiction, then explicitly confirm migration 0013.
-- Never infer country from base_currency, timezone, tenant or location.
ALTER TABLE branches ADD COLUMN country_code char(2) REFERENCES tax_jurisdictions(country_code);
ALTER TABLE branches ADD CONSTRAINT branches_id_tenant_key UNIQUE (id, tenant_id);
