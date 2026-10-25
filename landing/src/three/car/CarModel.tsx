import { Suspense, lazy } from 'react';
import type { CarMaterials } from '../materials';
import { CAR_ASSETS } from '../assets';

const ProceduralCar = lazy(() => import('./ProceduralCar'));
const GlbCar = lazy(() => import('./GlbCar'));

/**
 * The car. Renders the procedural model unless `CAR_ASSETS.model` points to a
 * GLB, in which case the GLB is loaded and its named nodes are mapped onto the
 * same exploded groups and material slots.
 */
export default function CarModel({ m }: { m: CarMaterials }) {
  return (
    <Suspense fallback={null}>
      {CAR_ASSETS.model ? <GlbCar m={m} url={CAR_ASSETS.model} /> : <ProceduralCar m={m} />}
    </Suspense>
  );
}
