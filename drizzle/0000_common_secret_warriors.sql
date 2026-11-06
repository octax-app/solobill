CREATE TABLE `api_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`last_used_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_hash_unique` ON `auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`subscription_id` integer,
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
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`original_invoice_line_id`) REFERENCES `original_invoice_lines`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_line_per_renewal_period` ON `invoice_lines` (`subscription_id`,`period_start`) WHERE subscription_id is not null and period_start is not null;--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`number` text,
	`issuer_key` text,
	`customer_id` integer NOT NULL,
	`provider_id` integer,
	`service_id` integer,
	`template_id` integer NOT NULL,
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
	`pdf_file` text,
	`paid_on` text,
	`converted_from_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_number_per_issuer` ON `invoices` (`issuer_key`,`type`,`number`);--> statement-breakpoint
CREATE INDEX `invoices_status` ON `invoices` (`type`,`status`);--> statement-breakpoint
CREATE TABLE `number_sequences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issuer_key` text NOT NULL,
	`type` text NOT NULL,
	`next_value` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sequence_per_issuer` ON `number_sequences` (`issuer_key`,`type`);--> statement-breakpoint
CREATE TABLE `original_invoice_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`original_invoice_id` integer NOT NULL,
	`description` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`total` integer NOT NULL,
	FOREIGN KEY (`original_invoice_id`) REFERENCES `original_invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `original_invoices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`logo_file` text,
	`website` text DEFAULT '' NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`default_template_id` integer,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`default_template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`ref_id` integer NOT NULL,
	`message` text NOT NULL,
	`link` text NOT NULL,
	`read_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_reminder_per_ref` ON `reminders` (`kind`,`ref_id`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`default_template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`base_currency` text DEFAULT 'USD' NOT NULL,
	`renewal_lead_days` integer DEFAULT 14 NOT NULL,
	`invoice_prefix` text DEFAULT 'INV-' NOT NULL,
	`proforma_prefix` text DEFAULT 'PF-' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `subscriptions_renewal` ON `subscriptions` (`status`,`next_renewal_on`);--> statement-breakpoint
CREATE TABLE `template_regions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `template_region_key` ON `template_regions` (`template_id`,`key`);--> statement-breakpoint
CREATE TABLE `templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
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
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);