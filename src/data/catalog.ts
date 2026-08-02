/**
 * Application entry point for catalog data.
 *
 * Everything in the app reads from here rather than importing products.ts directly,
 * so the zod parse in schema.ts runs exactly once, at module load, before any
 * component renders. A typo in the mock data fails the app at boot with a precise
 * message instead of surfacing as a mispriced configurator three screens later.
 */

import { categories as rawCategories } from './categories';
import { products as rawProducts } from './products';
import { parseCatalog } from './schema';
import type { Category, Product } from '../types/catalog';

const parsed = parseCatalog(rawProducts, rawCategories);

export const products: Product[] = parsed.products;
export const categories: Category[] = parsed.categories;

export const getProductBySlug = (slug: string): Product | undefined =>
  products.find((product) => product.slug === slug);

export const getCategoryById = (id: string): Category | undefined =>
  categories.find((category) => category.id === id);
