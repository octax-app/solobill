CREATE TABLE `invoice_payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`invoice_id` integer NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`paid_on` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`group_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invoice_payments_invoice` ON `invoice_payments` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `invoice_payments_group` ON `invoice_payments` (`group_id`);--> statement-breakpoint
ALTER TABLE `invoices` ADD `paid_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `discount_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `revenue_adjust_base` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO `invoice_payments` (`invoice_id`, `kind`, `amount`, `paid_on`, `note`, `created_at`, `updated_at`)
SELECT `id`, 'payment', `total`, `paid_on`, '', `updated_at`, `updated_at` FROM `invoices`
WHERE `status` = 'paid' AND `total` > 0 AND `paid_on` IS NOT NULL;--> statement-breakpoint
UPDATE `invoices` SET `paid_amount` = `total` WHERE `status` = 'paid';
