DROP INDEX `invoice_number_per_issuer`;--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_number_per_issuer` ON `invoices` (`issuer_key`,`type`,`number`) WHERE status <> 'void';