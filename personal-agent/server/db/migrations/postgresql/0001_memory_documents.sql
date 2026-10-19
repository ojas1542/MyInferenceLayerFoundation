CREATE TABLE "memory_documents" (
	"key" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
