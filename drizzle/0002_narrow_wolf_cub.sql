CREATE TABLE `device_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`api_token_id` integer NOT NULL,
	`token` text NOT NULL,
	`environment` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`api_token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_tokens_token_unique` ON `device_tokens` (`token`);--> statement-breakpoint
ALTER TABLE `reminders` ADD `pushed_at` text;
--> statement-breakpoint
-- Reminders from before push existed are not delivered as a backlog.
UPDATE `reminders` SET `pushed_at` = `created_at`;
