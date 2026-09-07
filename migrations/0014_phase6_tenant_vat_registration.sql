ALTER TABLE tenants ADD COLUMN vat_registration_status text NOT NULL DEFAULT 'unregistered'
  CHECK (vat_registration_status IN ('registered','unregistered'));
ALTER TABLE tenants ADD COLUMN vat_registration_number text;
ALTER TABLE tenants ADD CONSTRAINT tenants_vat_number_required_if_registered
  CHECK (vat_registration_status = 'unregistered' OR
    (vat_registration_number IS NOT NULL AND btrim(vat_registration_number) <> ''));
