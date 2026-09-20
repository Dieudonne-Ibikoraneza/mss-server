import { badRequest } from '@/common/errors/app-error';

/**
 * Every requested product must exist and still be on sale. `alreadyOrdered`
 * lets a revision keep a line for a product that was deactivated after the
 * order was placed — it is a commitment already made — while still refusing to
 * add one. The public catalogue hides inactive products, so a stale cart or a
 * direct request is the only way to ask for one.
 */
export function assertProductsOrderable(
  requestedIds: readonly string[],
  products: readonly { id: string; name: string; isActive: boolean }[],
  alreadyOrdered: ReadonlySet<string> = new Set(),
) {
  if (products.length !== requestedIds.length) {
    throw badRequest('catalog.productsNotFound', 'One or more products could not be found.');
  }
  const unavailable = products.filter(
    (product) => !product.isActive && !alreadyOrdered.has(product.id),
  );
  if (unavailable.length > 0) {
    const names = unavailable.map((product) => `"${product.name}"`).join(', ');
    throw unavailable.length === 1
      ? badRequest(
          'catalog.productUnavailableOne',
          '{{names}} is no longer available. Remove it and try again.',
          { names },
        )
      : badRequest(
          'catalog.productsUnavailableMany',
          '{{names}} are no longer available. Remove them and try again.',
          { names },
        );
  }
}
