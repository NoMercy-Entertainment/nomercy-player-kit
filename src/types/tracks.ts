// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

/**
 * Minimal decode-capability result returned by `player.canPlay(codec)`.
 * Maps directly onto the `MediaCapabilities.decodingInfo()` result so
 * consumers can gate quality-level selection on device capability.
 */
export interface CanPlayResult {
	/** `true` when the browser can decode this codec / container combination. */
	supported: boolean;
	/** `true` when the browser can decode smoothly (no dropped frames expected). */
	smooth: boolean;
	/** `true` when the browser can decode without excessive battery drain. */
	powerEfficient: boolean;
}

/**
 * Quality level metadata returned by `player.qualityLevels()` and populated
 * by stream parsers from the HLS manifest's `EXT-X-STREAM-INF` entries.
 * Consumers use this to render a quality picker.
 */
export interface QualityLevel {
	/** Stream bitrate in bits per second. */
	bitrate: number;
	/** Encoded video height in pixels, if known. */
	height?: number;
	/** Encoded video width in pixels, if known. */
	width?: number;
	/** Human-readable label (e.g. `'1080p'`). */
	label: string;
	/** Zero-based index in the manifest's level list. Pass to `quality(idx)`. */
	index: number;
	/**
	 * Set when `qualityLevels({ includeUnsupported: true })` is called.
	 * `true` = browser can decode this level; `false` = `MediaCapabilities`
	 * reports it as unsupported.
	 */
	supported?: boolean;
	/**
	 * `'hdr'` for streams tagged as HDR (HLS `VIDEO-RANGE` of `PQ` / `HLG`),
	 * `'sdr'` otherwise. Consumers can hide HDR levels when the active
	 * display does not advertise HDR support via `matchMedia('(dynamic-range: high)')`.
	 */
	dynamicRange?: 'sdr' | 'hdr';
}

/**
 * Audio track metadata returned by `player.audioTracks()`. Populated by the
 * active backend from the manifest's audio rendition list.
 */
export interface AudioTrack {
	/**
	 * Stable track identifier within this manifest. NOT what `audioTrack()`
	 * takes: that argument is a position in the list `audioTracks()` returned.
	 */
	id: string;
	/** BCP-47 language tag, if the manifest provides one (e.g. `'en'`, `'nl-NL'`). */
	language?: string;
	/** Human-readable label (e.g. `'English'`, `'Stereo'`). */
	label: string;
	/** Channel count, if reported by the manifest (e.g. `2` for stereo, `6` for 5.1). */
	channels?: number;
	/** `true` when this track is the manifest's default selection. */
	default?: boolean;
}

/**
 * Subtitle track metadata returned by `player.subtitles()`. Populated by the
 * active backend from the manifest's subtitle rendition list, augmented with
 * any sidecar tracks the consumer registered on the playlist item.
 */
export interface SubtitleTrack {
	/** Stable track identifier within this manifest. Pass to `subtitle(id)`. */
	id: string;
	/** BCP-47 language tag, if provided (e.g. `'en'`, `'nl-NL'`). */
	language?: string;
	/** Human-readable label (e.g. `'English (SDH)'`). */
	label: string;
	/** WebVTT / HLS kind hint. */
	kind?: 'subtitles' | 'captions' | 'descriptions';
	/** URL of the subtitle resource. */
	url: string;
	/** `true` when this track is the manifest's default selection. */
	default?: boolean;
	/**
	 * Optional flavor string — e.g. `'sdh'`, `'forced'`, `'full'`. Persisted
	 * by preference plugins so a saved `'English (SDH)'` pick is not silently
	 * swapped for `'English (Full)'` on the next load.
	 */
	type?: string;
}

/**
 * Input to `player.addSubtitleTrack()`. Describes a sidecar subtitle
 * resource the consumer already resolved (e.g. downloaded from a search
 * result) — deliberately transport-agnostic, no HTTP or provider specifics.
 * The player assigns `id`; `kind` defaults to `'subtitles'`.
 */
export interface SidecarSubtitleInput {
	/** URL of the subtitle resource. */
	url: string;
	/** BCP-47 language tag (e.g. `'en'`, `'nl-NL'`). */
	language: string;
	/** Human-readable label. Defaults to `language` when omitted. */
	label?: string;
	/**
	 * Optional flavor string — same free-form field as `SubtitleTrack.type`
	 * (e.g. `'sdh'`, `'forced'`, `'full'`). Not a container-format hint: every
	 * track added through this method is fetched and parsed as WebVTT.
	 */
	type?: string;
	/** Select this track immediately after adding it. Default `false`. */
	default?: boolean;
}

/**
 * Selection object returned by `player.subtitle()`. Carries both the
 * zero-based index (usable in `subtitle(idx)`) and the full track
 * metadata so callers don't need a separate `player.subtitles()[idx]` lookup.
 * `null` when subtitles are off.
 */
export interface CurrentSubtitleSelection {
	/** Zero-based index into the `subtitles()` list. */
	index: number;
	/** Full subtitle track metadata at this index. */
	track: SubtitleTrack;
}

/**
 * Selection object returned by `player.audioTrack()`. Carries both the
 * zero-based index and the full track metadata.
 * `null` when no explicit selection has been made.
 */
export interface CurrentAudioTrackSelection {
	/** Zero-based index into the `audioTracks()` list. */
	index: number;
	/** Full audio track metadata at this index. */
	track: AudioTrack;
}

/**
 * Selection object returned by `player.quality()`. Carries both the
 * level index and the full quality-level metadata.
 * `'auto'` when adaptive bitrate selection is active.
 */
export interface CurrentQualitySelection {
	/** Zero-based index into the `qualityLevels()` list. */
	index: number;
	/** Full quality-level metadata at this index. */
	track: QualityLevel;
}

/**
 * User-controlled subtitle styling. Written via `player.subtitleStyle({...})`,
 * persisted by preference plugins, and applied by overlay renderers.
 * Consumers write partial updates — any field omitted keeps its current value.
 */
export interface SubtitleStyle {
	/** Percentage of the renderer's base font size. Default 100. */
	fontSize: number;
	/** CSS font-family string (e.g. `'Arial'`, `'inherit'`). */
	fontFamily: string;
	/** CSS color string for the subtitle text. */
	textColor: string;
	/** Text opacity, 0–100 (percent). Folded into the alpha byte at render time. */
	textOpacity: number;
	/** CSS color string for the per-line text background box. */
	backgroundColor: string;
	/** Background box opacity, 0–100 (percent). */
	backgroundOpacity: number;
	/** Text edge rendering style — controls shadow / outline around characters. */
	edgeStyle: 'none' | 'depressed' | 'dropShadow' | 'raised' | 'uniform' | 'textShadow';
	/** CSS color string for the full subtitle window area (behind all cues). */
	areaColor: string;
	/** Window area opacity, 0–100 (percent). */
	windowOpacity: number;
}
