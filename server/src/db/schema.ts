import { pgTable, uuid, varchar, integer, bigint, decimal, jsonb, timestamp, text } from 'drizzle-orm/pg-core';
import type { FloorPlan, Point2D } from '../types';

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 200 }).notNull(),
  location: jsonb('location').$type<{ lat: number; lng: number; address: string }>().notNull(),
  total_floors: integer('total_floors').notNull(),
  amenities: jsonb('amenities').$type<string[]>().default([]),
  thumbnail_url: text('thumbnail_url'),
  // Baked lightmapped GLB (pipeline/bake), served from ASSETS_PATH. Null = procedural slabs only.
  model_url: text('model_url'),
  created_at: timestamp('created_at').defaultNow().notNull(),
});

export const floors = pgTable('floors', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).notNull(),
  floor_number: integer('floor_number').notNull(),
  label: varchar('label', { length: 100 }),
  floor_height: decimal('floor_height', { precision: 4, scale: 2 }).notNull().default('3.00'),
  svg_outline: text('svg_outline').notNull(),
  // Engineered plan (FloorPlan) from an IFC import. Served separately: it can be large.
  plan: jsonb('plan').$type<FloorPlan>(),
});

export const units = pgTable('units', {
  id: uuid('id').primaryKey().defaultRandom(),
  floor_id: uuid('floor_id').references(() => floors.id, { onDelete: 'cascade' }).notNull(),
  unit_code: varchar('unit_code', { length: 20 }).notNull(),
  polygon: jsonb('polygon').$type<Point2D[]>().notNull(),
  area_sqm: decimal('area_sqm', { precision: 6, scale: 2 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('available'),
  // Integer minor units (halalas/fils); divide by 100 for display.
  price: bigint('price', { mode: 'number' }).notNull(),
  facing: varchar('facing', { length: 5 }),
  bedrooms: integer('bedrooms').notNull(),
  bathrooms: integer('bathrooms').notNull(),
  reserved_until: timestamp('reserved_until'),
  updated_at: timestamp('updated_at').defaultNow().notNull(),
});

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  unit_id: uuid('unit_id').references(() => units.id, { onDelete: 'cascade' }).notNull(),
  room_type: varchar('room_type', { length: 50 }).notNull(),
  polygon: jsonb('polygon').$type<Point2D[]>().notNull(),
  area_sqm: decimal('area_sqm', { precision: 5, scale: 2 }),
  label: varchar('label', { length: 100 }),
});
