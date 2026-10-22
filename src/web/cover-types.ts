import type { ArticleCoverControls } from "@akairos/typeset-studio/cover";
import type { TypesetConfig } from "@akairos/typeset-studio/editor";
export interface CoverAsset { id: string; sha256: string; width: number; height: number; byteLength: number; url: string }
export interface TemplateAsset extends CoverAsset { contentType: string }
export interface CoverFont { id: string; family: string; label?: string; sha256: string }
export interface LegacyCoverTemplate { schemaVersion: 1; id: string; name: string; revision: number; controls: ArticleCoverControls; asset: CoverAsset; font: CoverFont }
export interface NativeCoverTemplate { schemaVersion: 2; id: string; name: string; revision: number; slot: NonNullable<TypesetConfig["slot"]>; config: TypesetConfig; assets: TemplateAsset[]; fonts: CoverFont[] }
export type CoverTemplate = LegacyCoverTemplate | NativeCoverTemplate;
