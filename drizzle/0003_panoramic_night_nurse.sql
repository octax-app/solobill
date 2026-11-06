CREATE TABLE `subscription_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subscription_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`description` text NOT NULL,
	`cost_amount` integer DEFAULT 0 NOT NULL,
	`price_amount` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subscription_lines_subscription` ON `subscription_lines` (`subscription_id`);--> statement-breakpoint
DROP INDEX `one_line_per_renewal_period`;--> statement-breakpoint
ALTER TABLE `invoice_lines` ADD `subscription_line_id` integer REFERENCES subscription_lines(id) ON DELETE SET NULL;--> statement-breakpoint
INSERT INTO `subscription_lines` (`subscription_id`, `position`, `description`, `cost_amount`, `price_amount`)
SELECT s.`id`, 0, CASE WHEN s.`label` = '' THEN sv.`name` ELSE sv.`name` || ', ' || s.`label` END, s.`cost_amount`, s.`price_amount`
FROM `subscriptions` s JOIN `services` sv ON sv.`id` = s.`service_id`;--> statement-breakpoint
UPDATE `invoice_lines` SET `subscription_line_id` = (
  SELECT sl.`id` FROM `subscription_lines` sl WHERE sl.`subscription_id` = `invoice_lines`.`subscription_id`
) WHERE `subscription_id` IS NOT NULL;--> statement-breakpoint
UPDATE `invoice_lines` SET `period_start` = NULL
WHERE `period_start` IS NOT NULL AND `invoice_id` IN (SELECT `id` FROM `invoices` WHERE `type` = 'proforma');--> statement-breakpoint
CREATE UNIQUE INDEX `one_subscription_line_per_period` ON `invoice_lines` (`subscription_line_id`,`period_start`) WHERE subscription_line_id is not null and period_start is not null;