import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';

/** Desktop post chain: ambient occlusion, restrained bloom, AgX tone mapping, vignette, SMAA. */
export default function Effects({ quality }: { quality: 'high' | 'low' }) {
  return (
    <EffectComposer multisampling={0} enableNormalPass={false}>
      <N8AO aoRadius={0.55} intensity={2.4} distanceFalloff={0.9} quality={quality === 'high' ? 'medium' : 'performance'} halfRes />
      <Bloom luminanceThreshold={1.35} luminanceSmoothing={0.3} intensity={0.42} mipmapBlur radius={0.5} />
      <ToneMapping mode={ToneMappingMode.AGX} />
      <Vignette eskil={false} offset={0.22} darkness={0.6} />
      <SMAA />
    </EffectComposer>
  );
}
