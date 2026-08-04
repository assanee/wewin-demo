import { ProductEditorScreen } from '@/components/products/product-editor';

export default async function ProductPage({
  params,
}: {
  readonly params: Promise<{ readonly productId: string }>;
}) {
  const { productId } = await params;
  return <ProductEditorScreen productId={productId} />;
}
