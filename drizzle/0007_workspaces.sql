-- Plan 22: every domain row belongs to a workspace. Written by hand: SQLite cannot add a
-- NOT NULL foreign key column in place, so each table is rebuilt. Runs with foreign_keys OFF
-- (see runMigrations), so dropping a parent table does not cascade to its children.
CREATE TABLE `workspaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `membership_per_user` ON `memberships` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_user` ON `memberships` (`user_id`);--> statement-breakpoint
-- Existing data moves into workspace 1. A fresh database (no users, no settings) gets none.
INSERT INTO `workspaces` (`id`, `name`, `created_at`, `updated_at`)
SELECT 1, 'My workspace', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM `users`) OR EXISTS (SELECT 1 FROM `settings`);--> statement-breakpoint
INSERT INTO `memberships` (`workspace_id`, `user_id`, `role`, `created_at`, `updated_at`)
SELECT 1, `id`, 'owner', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM `users`;--> statement-breakpoint
-- auth_sessions
CREATE TABLE `__new_auth_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_auth_sessions` (`id`, `token_hash`, `user_id`, `expires_at`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `token_hash`, `user_id`, `expires_at`, `created_at`, `updated_at`, 1 FROM `auth_sessions`;--> statement-breakpoint
DROP TABLE `auth_sessions`;--> statement-breakpoint
ALTER TABLE `__new_auth_sessions` RENAME TO `auth_sessions`;--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_hash_unique` ON `auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_sessions_workspace` ON `auth_sessions` (`workspace_id`);--> statement-breakpoint
-- api_tokens
CREATE TABLE `__new_api_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_api_tokens` (`id`, `token_hash`, `user_id`, `name`, `last_used_at`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `token_hash`, `user_id`, `name`, `last_used_at`, `created_at`, `updated_at`, 1 FROM `api_tokens`;--> statement-breakpoint
DROP TABLE `api_tokens`;--> statement-breakpoint
ALTER TABLE `__new_api_tokens` RENAME TO `api_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_workspace` ON `api_tokens` (`workspace_id`);--> statement-breakpoint
-- settings
CREATE TABLE `__new_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`base_currency` text DEFAULT 'USD' NOT NULL,
	`renewal_lead_days` integer DEFAULT 14 NOT NULL,
	`invoice_prefix` text DEFAULT 'INV-' NOT NULL,
	`proforma_prefix` text DEFAULT 'PF-' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_settings` (`id`, `base_currency`, `renewal_lead_days`, `invoice_prefix`, `proforma_prefix`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `base_currency`, `renewal_lead_days`, `invoice_prefix`, `proforma_prefix`, `created_at`, `updated_at`, 1 FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
CREATE UNIQUE INDEX `settings_per_workspace` ON `settings` (`workspace_id`);--> statement-breakpoint
-- fonts
CREATE TABLE `__new_fonts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`regular_file` text NOT NULL,
	`bold_file` text,
	`covers_arabic` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_fonts` (`id`, `name`, `regular_file`, `bold_file`, `covers_arabic`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `name`, `regular_file`, `bold_file`, `covers_arabic`, `created_at`, `updated_at`, 1 FROM `fonts`;--> statement-breakpoint
DROP TABLE `fonts`;--> statement-breakpoint
ALTER TABLE `__new_fonts` RENAME TO `fonts`;--> statement-breakpoint
CREATE INDEX `fonts_workspace` ON `fonts` (`workspace_id`);--> statement-breakpoint
-- templates
CREATE TABLE `__new_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`pdf_file` text NOT NULL,
	`page_count` integer DEFAULT 1 NOT NULL,
	`company_name` text DEFAULT '' NOT NULL,
	`company_address` text DEFAULT '' NOT NULL,
	`company_logo_file` text,
	`tax_number` text DEFAULT '' NOT NULL,
	`bank_details` text DEFAULT '' NOT NULL,
	`default_tax_rate` integer DEFAULT 50000 NOT NULL,
	`text_color` text DEFAULT '#1a1a21' NOT NULL,
	`line_height` real DEFAULT 1.32 NOT NULL,
	`font_id` integer,
	`separators` text DEFAULT '[]' NOT NULL,
	`custom_fields` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`font_id`) REFERENCES `fonts`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_templates` (`id`, `name`, `kind`, `is_default`, `pdf_file`, `page_count`, `company_name`, `company_address`, `company_logo_file`, `tax_number`, `bank_details`, `default_tax_rate`, `text_color`, `line_height`, `font_id`, `separators`, `custom_fields`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `name`, `kind`, `is_default`, `pdf_file`, `page_count`, `company_name`, `company_address`, `company_logo_file`, `tax_number`, `bank_details`, `default_tax_rate`, `text_color`, `line_height`, `font_id`, `separators`, `custom_fields`, `created_at`, `updated_at`, 1 FROM `templates`;--> statement-breakpoint
DROP TABLE `templates`;--> statement-breakpoint
ALTER TABLE `__new_templates` RENAME TO `templates`;--> statement-breakpoint
CREATE INDEX `templates_workspace` ON `templates` (`workspace_id`);--> statement-breakpoint
-- template_regions
CREATE TABLE `__new_template_regions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`template_id` integer NOT NULL,
	`key` text NOT NULL,
	`page` integer DEFAULT 0 NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`font_size` integer DEFAULT 10 NOT NULL,
	`align` text DEFAULT 'left' NOT NULL,
	`columns` text,
	`row_height` integer,
	`show_header` integer DEFAULT true NOT NULL,
	`color` text,
	`font_id` integer,
	`line_height` real,
	`borders` text,
	`border_color` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`font_id`) REFERENCES `fonts`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_template_regions` (`id`, `template_id`, `key`, `page`, `x`, `y`, `width`, `height`, `font_size`, `align`, `columns`, `row_height`, `show_header`, `color`, `font_id`, `line_height`, `borders`, `border_color`, `workspace_id`) SELECT `id`, `template_id`, `key`, `page`, `x`, `y`, `width`, `height`, `font_size`, `align`, `columns`, `row_height`, `show_header`, `color`, `font_id`, `line_height`, `borders`, `border_color`, 1 FROM `template_regions`;--> statement-breakpoint
DROP TABLE `template_regions`;--> statement-breakpoint
ALTER TABLE `__new_template_regions` RENAME TO `template_regions`;--> statement-breakpoint
CREATE INDEX `template_regions_workspace` ON `template_regions` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `template_region_key` ON `template_regions` (`template_id`,`key`);--> statement-breakpoint
-- providers
CREATE TABLE `__new_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`logo_file` text,
	`website` text DEFAULT '' NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`default_template_id` integer,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_providers` (`id`, `name`, `logo_file`, `website`, `details`, `default_template_id`, `archived_at`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `name`, `logo_file`, `website`, `details`, `default_template_id`, `archived_at`, `created_at`, `updated_at`, 1 FROM `providers`;--> statement-breakpoint
DROP TABLE `providers`;--> statement-breakpoint
ALTER TABLE `__new_providers` RENAME TO `providers`;--> statement-breakpoint
CREATE INDEX `providers_workspace` ON `providers` (`workspace_id`);--> statement-breakpoint
-- services
CREATE TABLE `__new_services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`provider_id` integer NOT NULL,
	`name` text NOT NULL,
	`pricing` text DEFAULT 'fixed' NOT NULL,
	`cycle` text DEFAULT 'monthly' NOT NULL,
	`default_cost` integer DEFAULT 0 NOT NULL,
	`default_price` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`default_template_id` integer,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_services` (`id`, `provider_id`, `name`, `pricing`, `cycle`, `default_cost`, `default_price`, `currency`, `default_template_id`, `archived_at`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `provider_id`, `name`, `pricing`, `cycle`, `default_cost`, `default_price`, `currency`, `default_template_id`, `archived_at`, `created_at`, `updated_at`, 1 FROM `services`;--> statement-breakpoint
DROP TABLE `services`;--> statement-breakpoint
ALTER TABLE `__new_services` RENAME TO `services`;--> statement-breakpoint
CREATE INDEX `services_workspace` ON `services` (`workspace_id`);--> statement-breakpoint
-- customers
CREATE TABLE `__new_customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`name` text NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`tax_number` text DEFAULT '' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_customers` (`id`, `status`, `name`, `company`, `email`, `phone`, `address`, `tax_number`, `currency`, `notes`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `status`, `name`, `company`, `email`, `phone`, `address`, `tax_number`, `currency`, `notes`, `created_at`, `updated_at`, 1 FROM `customers`;--> statement-breakpoint
DROP TABLE `customers`;--> statement-breakpoint
ALTER TABLE `__new_customers` RENAME TO `customers`;--> statement-breakpoint
CREATE INDEX `customers_workspace` ON `customers` (`workspace_id`);--> statement-breakpoint
-- subscriptions
CREATE TABLE `__new_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`customer_id` integer NOT NULL,
	`service_id` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`cycle` text NOT NULL,
	`started_on` text NOT NULL,
	`next_renewal_on` text,
	`cost_amount` integer DEFAULT 0 NOT NULL,
	`cost_currency` text DEFAULT 'USD' NOT NULL,
	`price_amount` integer DEFAULT 0 NOT NULL,
	`price_currency` text DEFAULT 'USD' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_subscriptions` (`id`, `customer_id`, `service_id`, `label`, `cycle`, `started_on`, `next_renewal_on`, `cost_amount`, `cost_currency`, `price_amount`, `price_currency`, `status`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `customer_id`, `service_id`, `label`, `cycle`, `started_on`, `next_renewal_on`, `cost_amount`, `cost_currency`, `price_amount`, `price_currency`, `status`, `created_at`, `updated_at`, 1 FROM `subscriptions`;--> statement-breakpoint
DROP TABLE `subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_subscriptions` RENAME TO `subscriptions`;--> statement-breakpoint
CREATE INDEX `subscriptions_workspace` ON `subscriptions` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_renewal` ON `subscriptions` (`status`,`next_renewal_on`);--> statement-breakpoint
-- subscription_lines
CREATE TABLE `__new_subscription_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`subscription_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`description` text NOT NULL,
	`cost_amount` integer DEFAULT 0 NOT NULL,
	`price_amount` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_subscription_lines` (`id`, `subscription_id`, `position`, `description`, `cost_amount`, `price_amount`, `workspace_id`) SELECT `id`, `subscription_id`, `position`, `description`, `cost_amount`, `price_amount`, 1 FROM `subscription_lines`;--> statement-breakpoint
DROP TABLE `subscription_lines`;--> statement-breakpoint
ALTER TABLE `__new_subscription_lines` RENAME TO `subscription_lines`;--> statement-breakpoint
CREATE INDEX `subscription_lines_workspace` ON `subscription_lines` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `subscription_lines_subscription` ON `subscription_lines` (`subscription_id`);--> statement-breakpoint
-- original_invoices
CREATE TABLE `__new_original_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`provider_id` integer NOT NULL,
	`service_id` integer,
	`number` text DEFAULT '' NOT NULL,
	`issued_on` text NOT NULL,
	`due_on` text,
	`currency` text NOT NULL,
	`fx_rate` integer NOT NULL,
	`subtotal` integer DEFAULT 0 NOT NULL,
	`tax` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`base_subtotal` integer DEFAULT 0 NOT NULL,
	`base_total` integer DEFAULT 0 NOT NULL,
	`paid_on` text,
	`pdf_file` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_original_invoices` (`id`, `provider_id`, `service_id`, `number`, `issued_on`, `due_on`, `currency`, `fx_rate`, `subtotal`, `tax`, `total`, `base_subtotal`, `base_total`, `paid_on`, `pdf_file`, `notes`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `provider_id`, `service_id`, `number`, `issued_on`, `due_on`, `currency`, `fx_rate`, `subtotal`, `tax`, `total`, `base_subtotal`, `base_total`, `paid_on`, `pdf_file`, `notes`, `created_at`, `updated_at`, 1 FROM `original_invoices`;--> statement-breakpoint
DROP TABLE `original_invoices`;--> statement-breakpoint
ALTER TABLE `__new_original_invoices` RENAME TO `original_invoices`;--> statement-breakpoint
CREATE INDEX `original_invoices_workspace` ON `original_invoices` (`workspace_id`);--> statement-breakpoint
-- original_invoice_lines
CREATE TABLE `__new_original_invoice_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`original_invoice_id` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`total` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`original_invoice_id`) REFERENCES `original_invoices`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_original_invoice_lines` (`id`, `original_invoice_id`, `description`, `quantity`, `unit_price`, `total`, `workspace_id`) SELECT `id`, `original_invoice_id`, `description`, `quantity`, `unit_price`, `total`, 1 FROM `original_invoice_lines`;--> statement-breakpoint
DROP TABLE `original_invoice_lines`;--> statement-breakpoint
ALTER TABLE `__new_original_invoice_lines` RENAME TO `original_invoice_lines`;--> statement-breakpoint
CREATE INDEX `original_invoice_lines_workspace` ON `original_invoice_lines` (`workspace_id`);--> statement-breakpoint
-- invoices
CREATE TABLE `__new_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`number` text,
	`issuer_key` text,
	`customer_id` integer NOT NULL,
	`provider_id` integer,
	`service_id` integer,
	`template_id` integer NOT NULL,
	`issue_date` text,
	`issued_on` text,
	`due_on` text,
	`valid_until` text,
	`currency` text NOT NULL,
	`fx_rate` integer NOT NULL,
	`tax_enabled` integer DEFAULT false NOT NULL,
	`tax_rate` integer DEFAULT 0 NOT NULL,
	`subtotal` integer DEFAULT 0 NOT NULL,
	`tax` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`base_subtotal` integer DEFAULT 0 NOT NULL,
	`base_total` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`seller_snapshot` text,
	`paid_amount` integer DEFAULT 0 NOT NULL,
	`discount_amount` integer DEFAULT 0 NOT NULL,
	`revenue_adjust_base` integer DEFAULT 0 NOT NULL,
	`custom_values` text DEFAULT '{}' NOT NULL,
	`custom_snapshot` text,
	`pdf_file` text,
	`paid_on` text,
	`converted_from_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_invoices` (`id`, `type`, `status`, `source`, `number`, `issuer_key`, `customer_id`, `provider_id`, `service_id`, `template_id`, `issue_date`, `issued_on`, `due_on`, `valid_until`, `currency`, `fx_rate`, `tax_enabled`, `tax_rate`, `subtotal`, `tax`, `total`, `base_subtotal`, `base_total`, `notes`, `seller_snapshot`, `paid_amount`, `discount_amount`, `revenue_adjust_base`, `custom_values`, `custom_snapshot`, `pdf_file`, `paid_on`, `converted_from_id`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `type`, `status`, `source`, `number`, `issuer_key`, `customer_id`, `provider_id`, `service_id`, `template_id`, `issue_date`, `issued_on`, `due_on`, `valid_until`, `currency`, `fx_rate`, `tax_enabled`, `tax_rate`, `subtotal`, `tax`, `total`, `base_subtotal`, `base_total`, `notes`, `seller_snapshot`, `paid_amount`, `discount_amount`, `revenue_adjust_base`, `custom_values`, `custom_snapshot`, `pdf_file`, `paid_on`, `converted_from_id`, `created_at`, `updated_at`, 1 FROM `invoices`;--> statement-breakpoint
DROP TABLE `invoices`;--> statement-breakpoint
ALTER TABLE `__new_invoices` RENAME TO `invoices`;--> statement-breakpoint
CREATE INDEX `invoices_workspace` ON `invoices` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_number_per_issuer` ON `invoices` (`workspace_id`,`issuer_key`,`type`,`number`) WHERE status <> 'void';--> statement-breakpoint
CREATE INDEX `invoices_status` ON `invoices` (`type`,`status`);--> statement-breakpoint
-- invoice_payments
CREATE TABLE `__new_invoice_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`invoice_id` integer NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`paid_on` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`group_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_invoice_payments` (`id`, `invoice_id`, `kind`, `amount`, `paid_on`, `note`, `group_id`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `invoice_id`, `kind`, `amount`, `paid_on`, `note`, `group_id`, `created_at`, `updated_at`, 1 FROM `invoice_payments`;--> statement-breakpoint
DROP TABLE `invoice_payments`;--> statement-breakpoint
ALTER TABLE `__new_invoice_payments` RENAME TO `invoice_payments`;--> statement-breakpoint
CREATE INDEX `invoice_payments_workspace` ON `invoice_payments` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `invoice_payments_invoice` ON `invoice_payments` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `invoice_payments_group` ON `invoice_payments` (`group_id`);--> statement-breakpoint
-- invoice_lines
CREATE TABLE `__new_invoice_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`invoice_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`subscription_id` integer,
	`subscription_line_id` integer,
	`period_start` text,
	`description` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`net` integer DEFAULT 0 NOT NULL,
	`tax` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`cost_amount` integer DEFAULT 0 NOT NULL,
	`cost_currency` text NOT NULL,
	`cost_fx_rate` integer NOT NULL,
	`cost_base` integer DEFAULT 0 NOT NULL,
	`original_invoice_line_id` integer,
	`amount_confirmed` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subscription_line_id`) REFERENCES `subscription_lines`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`original_invoice_line_id`) REFERENCES `original_invoice_lines`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_invoice_lines` (`id`, `invoice_id`, `position`, `subscription_id`, `subscription_line_id`, `period_start`, `description`, `quantity`, `unit_price`, `net`, `tax`, `total`, `cost_amount`, `cost_currency`, `cost_fx_rate`, `cost_base`, `original_invoice_line_id`, `amount_confirmed`, `workspace_id`) SELECT `id`, `invoice_id`, `position`, `subscription_id`, `subscription_line_id`, `period_start`, `description`, `quantity`, `unit_price`, `net`, `tax`, `total`, `cost_amount`, `cost_currency`, `cost_fx_rate`, `cost_base`, `original_invoice_line_id`, `amount_confirmed`, 1 FROM `invoice_lines`;--> statement-breakpoint
DROP TABLE `invoice_lines`;--> statement-breakpoint
ALTER TABLE `__new_invoice_lines` RENAME TO `invoice_lines`;--> statement-breakpoint
CREATE INDEX `invoice_lines_workspace` ON `invoice_lines` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_subscription_line_per_period` ON `invoice_lines` (`subscription_line_id`,`period_start`) WHERE subscription_line_id is not null and period_start is not null;--> statement-breakpoint
-- number_sequences
CREATE TABLE `__new_number_sequences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`issuer_key` text NOT NULL,
	`type` text NOT NULL,
	`next_value` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_number_sequences` (`id`, `issuer_key`, `type`, `next_value`, `workspace_id`) SELECT `id`, `issuer_key`, `type`, `next_value`, 1 FROM `number_sequences`;--> statement-breakpoint
DROP TABLE `number_sequences`;--> statement-breakpoint
ALTER TABLE `__new_number_sequences` RENAME TO `number_sequences`;--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_per_issuer` ON `number_sequences` (`workspace_id`,`issuer_key`,`type`);--> statement-breakpoint
-- reminders
CREATE TABLE `__new_reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`kind` text NOT NULL,
	`ref_id` integer NOT NULL,
	`message` text NOT NULL,
	`link` text NOT NULL,
	`read_at` text,
	`pushed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_reminders` (`id`, `kind`, `ref_id`, `message`, `link`, `read_at`, `pushed_at`, `created_at`, `updated_at`, `workspace_id`) SELECT `id`, `kind`, `ref_id`, `message`, `link`, `read_at`, `pushed_at`, `created_at`, `updated_at`, 1 FROM `reminders`;--> statement-breakpoint
DROP TABLE `reminders`;--> statement-breakpoint
ALTER TABLE `__new_reminders` RENAME TO `reminders`;--> statement-breakpoint
CREATE UNIQUE INDEX `one_reminder_per_ref` ON `reminders` (`workspace_id`,`kind`,`ref_id`);
