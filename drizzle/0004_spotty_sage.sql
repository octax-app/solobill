CREATE TABLE `fonts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`regular_file` text NOT NULL,
	`bold_file` text,
	`covers_arabic` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `invoices` ADD `custom_values` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD `custom_snapshot` text;--> statement-breakpoint
ALTER TABLE `template_regions` ADD `color` text;--> statement-breakpoint
ALTER TABLE `template_regions` ADD `font_id` integer REFERENCES fonts(id);--> statement-breakpoint
ALTER TABLE `template_regions` ADD `line_height` real;--> statement-breakpoint
ALTER TABLE `template_regions` ADD `borders` text;--> statement-breakpoint
ALTER TABLE `template_regions` ADD `border_color` text;--> statement-breakpoint
ALTER TABLE `templates` ADD `text_color` text DEFAULT '#1a1a21' NOT NULL;--> statement-breakpoint
ALTER TABLE `templates` ADD `line_height` real DEFAULT 1.32 NOT NULL;--> statement-breakpoint
ALTER TABLE `templates` ADD `font_id` integer REFERENCES fonts(id);--> statement-breakpoint
ALTER TABLE `templates` ADD `separators` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `templates` ADD `custom_fields` text DEFAULT '[]' NOT NULL;