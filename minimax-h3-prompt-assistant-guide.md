# Building a Prompt Assistant for MiniMax H3

**Research-based prompting instructions, generation logic, output schemas, and implementation recommendations**

_Last researched: 24 August 2026_

## Executive summary

MiniMax H3 is not merely a text-to-video model. It is a general-purpose multimodal audio-video model that can interpret text, images, video, and audio together and generate a short video with synchronized stereo sound. A strong H3 prompt therefore behaves less like a bag of visual keywords and more like compact production documentation: it identifies what each input asset contributes, describes what happens in playback order, controls camera behavior, preserves identities and objects, and separately directs dialogue, physical sound, and audience-only music.

The most important recommendation for a prompt-assistant product is to **route the request into the correct H3 generation mode before writing the prompt**:

1. **T2VA — text-to-audio-video:** no visual reference frame or multimodal reference.
2. **I2VA — first-frame image-to-audio-video:** one image must be the exact opening frame.
3. **L2VA — last-frame image-to-audio-video:** one image must be the exact ending frame.
4. **FL2VA — first-and-last-frame-to-audio-video:** two images define the exact beginning and ending.
5. **Ref2VA — reference-to-audio-video:** images, videos, or audio guide identity, environment, style, motion, camera work, editing, voice, sound, or music.

The official API treats first/last-frame generation and reference generation as mutually exclusive. Your assistant must therefore ask what an uploaded image is supposed to do rather than inferring that every uploaded image is a first frame.

A production-grade assistant should produce two outputs:

- A **machine-readable generation plan** for your application.
- A **rendered H3 prompt** following the official H3 structure.

For the hosted MiniMax API, strongly consider offering a second optimization route that calls **H3-Context-IR**, MiniMax’s official multimodal prompt-enhancement endpoint. It returns an enriched prompt but does not itself generate video. The local/open-weight route can instead use your own prompt compiler based on the official prompting guides.

> **Product-language recommendation:** Do not promise a “perfect prompt.” Video generation remains stochastic, and prompt adherence is not absolute. Position the feature as producing a **production-ready, H3-optimized prompt** with validation, explicit assumptions, and optional variants.

## 1. Verified H3 capabilities and constraints

According to MiniMax’s official documentation, MiniMax H3 supports unified multimodal understanding across text, image, video, and audio. It can generate native stereo audio together with the video. The hosted API supports 768P and 2K output, integer durations from 4 to 15 seconds, and common aspect ratios including 21:9, 16:9, 4:3, 1:1, 3:4, and 9:16.

### 1.1 Generation modes

| Mode | Inputs | Intended use |
|---|---|---|
| T2VA | Text only | Create the complete audiovisual scene from scratch |
| I2VA | Text + first-frame image | Animate forward from an exact opening image |
| L2VA | Text + last-frame image | Generate a plausible preceding action that lands on an exact ending image |
| FL2VA | Text + first-frame and last-frame images | Create a continuous transition between exact opening and ending frames |
| Ref2VA | Text + reference images, video, or audio | Guide identity, environment, objects, style, motion, camera, editing, voice, sound, or music |

### 1.2 Hosted API limits relevant to the assistant

| Input or setting | Official constraint |
|---|---|
| Prompt | Required, non-empty, maximum 7,000 characters for video generation |
| Duration | Integer from 4 through 15 seconds |
| Resolution | 768P or 2K |
| First/last-frame images | Zero, one, or two images |
| Reference images | Up to 9 |
| Reference videos | Up to 3; each 2–15 seconds; total video duration up to 15 seconds |
| Reference audio | Up to 3; each 2–15 seconds; total audio duration up to 15 seconds |
| Mixed reference files | Up to 12 total |
| Image dimensions | Width and height each between 256 and 5,760 pixels |
| Input aspect ratio | Width/height between 0.4 and 2.5 |
| Video file size | Up to 50 MB per file |
| Image file size | Up to 30 MB per file |
| Audio file size | Up to 15 MB per file |
| Request body | Up to 64 MB; public URLs are recommended for large media |

Important API behavior:

- Text-to-video requires an explicit, non-adaptive aspect ratio.
- First/last-frame mode derives its ratio from the input image; API ratio selection is effectively adaptive.
- Reference mode may use adaptive or a concrete output ratio.
- First/last-frame assets cannot be mixed with reference-role assets in the same request.
- Generation and H3-Context-IR are asynchronous tasks.

Official references:

- [MiniMax H3 announcement and technical overview](https://www.minimax.io/blog/minimax-h3)
- [MiniMax H3 open-source system overview](https://www.minimax.io/news/minimax-h3-open-source)
- [Video Generation guide](https://platform.minimax.io/docs/guides/video-generation)
- [Create Video Generation Task API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)
- [Create H3-Context-IR Task API](https://platform.minimax.io/docs/api-reference/video-generation-v2-h3-context-ir)

## 2. Core prompting principles

### 2.1 Choose the mode before writing prose

Mode selection changes both API construction and prompt syntax. The assistant should not begin by “making the idea more cinematic.” It should first determine whether uploaded media is:

- an exact first frame;
- an exact last frame;
- a character or product reference;
- an environment reference;
- a style reference;
- a storyboard or composition reference;
- a motion or camera reference;
- a source video to edit;
- a source video to continue;
- a voice, sound, rhythm, or music reference.

A single image can theoretically suggest several roles, but the assistant should assign **one primary role per intended control**. Ambiguous roles produce contradictory instructions.

### 2.2 Give every reference an explicit job

Weak:

> Use the attached images and video as references.

Strong:

> Image 1 defines the presenter’s facial identity, hairstyle, and navy jacket. Image 2 defines the product’s geometry, materials, labels, and logo placement. Video 1 provides only the hand movement and slow clockwise arc of the camera; do not copy its person, wardrobe, or background.

For each asset, record:

1. **What to preserve or transfer.**
2. **What may change.**
3. **Where in the target timeline it applies.**
4. **Whether the source signal is copied, referenced, edited, or used only weakly.**
5. **Which other asset wins if references conflict.**

### 2.3 Describe a changing timeline, not a still image

A video prompt must explain what changes over time:

- initial state;
- action onset;
- intermediate physical changes;
- subject or object reaction;
- camera response;
- final state.

A useful micro-structure is:

> **Beginning state → trigger → action chain → reaction → ending state**

A list such as “cinematic, beautiful, dramatic light, 4K, shallow depth of field” defines appearance but not video behavior.

### 2.4 Use observable instructions

Prefer details that could be verified in the output:

- “She turns her head toward the machine and raises her left hand.”
- “The camera trucks right by roughly one body width at slow speed.”
- “The red status light changes to green after the wafer stage stops.”
- “The final frame holds for the last half-second.”

Avoid relying mainly on abstractions:

- “Make it inspiring.”
- “It feels innovative.”
- “Create a premium vibe.”

Translate abstractions into visible and audible choices. For example, “premium” might become controlled camera motion, limited cutting, precise product lighting, clean surfaces, sparse score, and restrained dialogue.

### 2.5 Control complexity against duration

H3 outputs 4–15 seconds. The prompt assistant should estimate whether the requested content fits.

Recommended default budgets:

| Duration | Suggested visual structure | Dialogue guidance |
|---|---|---|
| 4–6 s | One shot; occasionally two simple shots | One short line or no dialogue |
| 7–10 s | One developed shot or two to three shots | One to two concise lines |
| 11–15 s | Two to four purposeful shots | A few short lines with clear speaker ownership |

These are product heuristics, not hard model limits. The important rule is to avoid cramming many actions, cuts, speakers, transformations, text overlays, and audio events into a short clip.

### 2.6 Make cuts purposeful

The official guide recommends using a cut only when it introduces new information about subject, space, state, viewpoint, or time. If only the framing distance or angle changes slightly, use camera movement instead.

Later shots should have increasing cut timestamps:

```text
[Shot 1] ...
[Shot 2] At 00:03.500, the camera cuts to ...
[Shot 3] At 00:07.250, the shot changes to ...
```

Do not timestamp Shot 1. Do not create overlapping, decreasing, or out-of-duration timestamps.

### 2.7 Write camera movement as motion type, amplitude, and speed

Officially documented motion language includes:

- Zoom In / Zoom Out
- Push In / Pull Out
- Pan Left / Pan Right
- Truck Left / Truck Right
- Tilt Up / Tilt Down
- Pedestal Up / Pedestal Down
- Arc Shot
- Tracking Shot
- Static Shot
- Shake Slightly / Shake Strongly
- POV
- Roll Clockwise / Roll Counterclockwise

When relevant, add:

- `with small amplitude` or `with large amplitude`;
- `at slow speed` or `at fast speed`.

Use natural prose rather than a tag pile:

```text
The camera pushes in with small amplitude at slow speed toward the product label.
```

Do not confuse:

- **Zoom:** lens focal length changes while camera position remains fixed.
- **Push in:** the physical camera moves toward the subject.
- **Pan:** camera rotates horizontally from a fixed position.
- **Truck:** camera translates horizontally.

### 2.8 Separate the audio layers

H3 jointly generates picture and native stereo sound. The prompt should therefore distinguish:

1. **Dialogue or singing:** tied to a speaker and placed in the shot timeline.
2. **Diegetic audio:** sounds occurring inside the scene, such as machinery, footsteps, impacts, room ambience, or a radio the characters can hear.
3. **Non-diegetic music:** score audible only to the audience.

The official base format uses:

```text
overall_soundscape: ...

non_diegetic_music: ...
```

`overall_soundscape` should summarize ambience, physical sounds, and non-verbal human sounds. It should not duplicate dialogue.

`non_diegetic_music` should name instrumentation, tempo, rhythm, and dynamic development. Use `N/A` when no audience-only score is desired.

### 2.9 Preserve exact dialogue and visible text

Dialogue uses stable speaker IDs and the official dialogue wrapper:

```text
The engineer with a clear, measured voice (S1) says: <d>[English] Alignment complete.</d>
```

Rules:

- Assign speaker IDs in order of actual vocal events.
- Keep the same speaker ID across shots.
- Put speaker identity, delivery, and action outside `<d>`.
- Put only the language tag and exact spoken content inside `<d>`.
- Preserve user-provided dialogue verbatim; do not silently rewrite or translate it.
- For voiceover, use the phrase `says in an off-screen voiceover` and state that the corresponding visible character’s lips remain closed.
- On-screen text should appear in English double quotation marks and preserve exact spelling and punctuation.

For the assistant UI, dialogue and visible text should be separate user-editable fields because tiny wording changes can materially affect timing and brand accuracy.

## 3. Official prompt structures

The official MiniMax prompting guides define two major output families:

- Base prompting for T2VA, I2VA, FL2VA, and L2VA.
- Full-reference prompting for Ref2VA.

Primary official sources:

- [Official base prompt-writing guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)
- [Official full-reference prompt-writing guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)

### 3.1 T2VA output structure

```text
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

### 3.2 I2VA output structure

The first line is fixed:

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

The body should follow:

> first-frame anchor → action onset → continuous development → result or reaction

### 3.3 FL2VA output structure

```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.

integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

Replace `N` with the actual final shot number and `S.SS` with the exact target duration to two decimal places.

Recommended narrative path:

> first-frame state → observable intermediate changes → progressively narrowing differences → last-frame state

A single shot is normally preferable unless the user explicitly requires multiple shots.

### 3.4 L2VA output structure

```text
How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.

integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

Recommended narrative path:

> plausible preceding state → explicit action and transition path → gradual convergence → exact last-frame landing

### 3.5 Ref2VA output structure

The official full-reference structure contains six sections in this order:

```text
subject_definitions:
...

summary:
...

retention_analysis:
...

detailed_description:
...

overall_soundscape:
...

non_diegetic_music:
...
```

#### `subject_definitions`

Define stable reference labels:

- `<Subject N>`: reusable visible content such as a person, product, environment, costume, visual effect, action, pose, or style.
- `<Picture N>`: an image used as a concrete frame, keyframe, edited frame, composition anchor, or storyboard anchor.
- `<Video N>`: a whole-video relationship such as source-video editing, continuation, camera structure, cuts, rhythm, or temporal structure.
- `<Audio N>`: copied or referenced audio, voice timbre, sound texture, rhythm, dialogue source, or music.

Important distinction: the file itself is not always the subject. A video might be `<Video 1>` as the editing source while a person visible inside it is separately `<Subject 1>`.

#### `summary`

Begin with one or more official task-type markers:

- `[keyframe completion]`
- `[reference generation]`
- `[video editing]`
- `[video continuation]`
- `[audio reuse]`
- `[audio reference]`

Combine applicable types with `+`.

#### `retention_analysis`

Use fixed relationship markers.

For visual references:

- `fully_preserved`
- `partially_preserved`
- `attribute_transfer`
- `weak_reference`

For audio references:

- `fully_copy`
- `partially_copy`
- `reference`
- `weak_reference`

#### `detailed_description`

Describe the target in playback order, inserting the stable reference labels where their effects occur. The official guide recommends detailed, explicit descriptions rather than plot summaries. For generation tasks, it suggests roughly 350–500 English words, while dialogue-heavy or editing tasks should scale according to timeline and source complexity.

#### Audio sections

Use `overall_soundscape` and `non_diegetic_music` as in the base format, while explicitly naming `<Audio N>` where a reference relationship applies.

## 4. Recommended assistant workflow

### Step 1: Normalize the user request

Extract or ask for:

- core idea and desired outcome;
- target duration;
- aspect ratio or destination channel;
- visual style and production form;
- subject or product;
- location/environment;
- required action;
- required ending;
- dialogue, voiceover, singing, and language;
- ambient sound, physical sound, and music;
- visible text or logos;
- uploaded assets and intended roles;
- absolute preservation requirements;
- prohibited changes;
- creative freedom level.

Do not force every user through a long form. Use progressive disclosure: start with the idea and media, then ask only high-impact questions that cannot be safely inferred.

### Step 2: Analyze uploaded media

For each image, record:

- candidate subjects and objects;
- composition and camera angle;
- lighting and palette;
- wardrobe and appearance anchors;
- product geometry, materials, labels, and logo placement;
- environment;
- visible text;
- likely role candidates;
- conflicts with other assets.

For each video, record:

- subjects and environment;
- shot boundaries and timestamps;
- camera movement;
- action and gesture timeline;
- pacing and editing rhythm;
- synchronized audio components;
- whether the user wants editing, continuation, motion transfer, camera transfer, rhythm transfer, or only visual reference.

For each audio file, record:

- voice versus music versus sound effects;
- language and transcript where intelligible;
- speaker timbre and delivery;
- beat and tempo;
- whether the user wants direct reuse or only reference.

Media analysis must remain an **internal interpretation** until role assignment is confirmed. “Image contains a person” does not tell you whether the user wants identity preservation, wardrobe preservation, style transfer, or an exact first frame.

### Step 3: Route the mode

Use the following decision logic:

```text
IF no media is supplied:
    mode = T2VA
ELSE IF user requires an uploaded image to be the exact first frame
        AND no reference-role media is needed:
    mode = I2VA
ELSE IF user requires an uploaded image to be the exact last frame
        AND no reference-role media is needed:
    mode = L2VA
ELSE IF user requires exact first and exact last frames
        AND no reference-role media is needed:
    mode = FL2VA
ELSE:
    mode = Ref2VA
```

If the user wants both an exact first frame and separate character, style, or motion references, flag the hosted API role conflict. Offer one of these strategies:

1. Use Ref2VA and treat the opening image as a strong composition reference rather than a guaranteed exact first frame.
2. First create a reference-guided opening frame outside H3, then run I2VA/FL2VA.
3. Split the creative into multiple generation steps and edit the outputs together.

### Step 4: Build a generation plan

Create a structured plan before rendering prose:

- mode;
- duration;
- ratio;
- resolution;
- shot count;
- cut times;
- shot objectives;
- subject continuity anchors;
- asset-role map;
- camera plan;
- action path;
- ending condition;
- speaker map;
- exact dialogue;
- diegetic sound plan;
- non-diegetic music plan;
- visible-text requirements;
- hard constraints;
- assumptions and confidence.

### Step 5: Resolve contradictions

Examples of contradictions:

- “static camera” and “fast orbit around the product”;
- “exactly preserve the source video” and “replace the location and camera angle”;
- “silent video” and “include dialogue”;
- “exact first frame” combined with Ref2VA assets;
- more actions than can plausibly fit the duration;
- two references defining different faces for the same person;
- an uploaded motion reference with a very different body configuration from the target subject;
- requested visible text that conflicts with a product-reference label.

Your assistant should not quietly choose. It should either ask a focused question or apply an explicit priority rule and disclose the assumption.

Recommended priority order:

1. User-declared hard constraints.
2. Exact dialogue and visible text.
3. Explicit asset roles.
4. Subject/product identity and geometry.
5. Start/end-frame alignment.
6. Main action and ending.
7. Camera plan.
8. Style, lighting, and ambience.
9. Decorative detail.

### Step 6: Expand into H3-native prose

Expansion should be controlled, not merely verbose. Add only details that:

- resolve ambiguity;
- support continuity;
- make an action observable;
- make camera behavior executable;
- clarify sound timing;
- specify reference relationships;
- establish a useful final state.

Do not invent brand claims, product functions, technical behavior, legal text, or spoken quotations.

### Step 7: Validate

Run deterministic validation before presenting or sending the prompt.

#### Structural validation

- Correct sections for selected mode.
- Correct first-line alignment instruction for I2VA, L2VA, or FL2VA.
- Correct six-section order for Ref2VA.
- All referenced labels are defined.
- No label changes meaning between sections.
- No undeclared speaker IDs.
- All dialogue uses `<d>[Language] ...</d>`.
- Exact visible text is in double quotation marks.

#### Timeline validation

- Shot numbers are sequential.
- Shot 1 has no cut timestamp.
- Later cut times are strictly increasing.
- All cut times fall within duration.
- Final action can plausibly finish before the video ends.
- First/last-frame alignment uses the correct final shot and exact duration.

#### API validation

- Prompt is non-empty and no more than 7,000 characters for direct generation.
- Duration is an integer from 4 through 15.
- T2VA has a concrete ratio.
- First/last-frame and reference roles are not mixed.
- Asset counts, sizes, durations, dimensions, and formats fit API limits.

#### Creative validation

- Main subject is clear.
- Main action is clear.
- Ending condition is explicit.
- Camera instructions do not contradict each other.
- Each reference has one or more explicit jobs.
- Preservation requirements are observable.
- Sound is directed rather than assumed.
- Prompt detail matches duration.

### Step 8: Produce controlled variants

Instead of returning one supposedly perfect prompt, optionally return:

- **Faithful:** maximizes reference preservation and minimizes invention.
- **Balanced:** preserves essentials while adding cinematic detail.
- **Expressive:** takes more creative freedom in style, camera, and audio.

The variants should preserve all hard constraints and exact dialogue.

## 5. Suggested machine-readable schema

Use a typed intermediate representation before generating the final H3 prose.

```json
{
  "model": "MiniMax-H3",
  "mode": "t2va | i2va | l2va | fl2va | ref2va",
  "duration_seconds": 8,
  "ratio": "16:9",
  "resolution": "2K",
  "creative_freedom": "faithful | balanced | expressive",
  "user_intent": {
    "goal": "Short description of the intended viewer experience",
    "main_subject": "Primary subject or product",
    "main_action": "Primary visible action",
    "ending_condition": "Required state in the final moment",
    "style": "Visual production form and concrete stylistic anchors",
    "must_preserve": [],
    "must_avoid": [],
    "visible_text": [],
    "exact_dialogue": []
  },
  "assets": [
    {
      "id": "image_1",
      "type": "image",
      "api_role": "first_frame | last_frame | reference_image",
      "semantic_roles": ["identity", "product", "environment", "style"],
      "preserve": [],
      "ignore": [],
      "applies_to_shots": [1],
      "priority": 100
    }
  ],
  "subjects": [
    {
      "id": "subject_1",
      "label": "<Subject 1>",
      "source_assets": ["image_1"],
      "identity_anchors": [],
      "mutable_attributes": [],
      "speaker_id": null
    }
  ],
  "shots": [
    {
      "shot_number": 1,
      "start_seconds": 0,
      "end_seconds": 4.5,
      "objective": "Establish subject and begin action",
      "composition": "Medium-wide eye-level shot",
      "subjects": ["subject_1"],
      "actions": [],
      "camera": {
        "type": "push_in",
        "amplitude": "small",
        "speed": "slow"
      },
      "diegetic_audio_events": [],
      "dialogue_events": [],
      "visible_text_events": []
    }
  ],
  "overall_soundscape": {
    "ambience": [],
    "physical_sounds": [],
    "nonverbal_human_sounds": []
  },
  "non_diegetic_music": {
    "enabled": true,
    "instrumentation": [],
    "tempo": "slow",
    "rhythm": "sparse",
    "dynamic_arc": "gradually increases, then fades"
  },
  "assumptions": [],
  "warnings": [],
  "confidence": 0.86
}
```

This intermediate schema allows deterministic validation, UI editing, prompt-version comparison, and later support for other video models.

## 6. Asset-role ontology

Your assistant should maintain a controlled vocabulary for asset roles.

### 6.1 Image roles

- `first_frame`
- `last_frame`
- `character_identity`
- `face_identity`
- `wardrobe`
- `product_geometry`
- `product_material`
- `logo_or_label`
- `environment`
- `lighting`
- `color_palette`
- `visual_style`
- `composition`
- `storyboard`
- `pose`
- `keyframe`

### 6.2 Video roles

- `source_video_edit`
- `source_video_continuation`
- `motion_reference`
- `gesture_reference`
- `camera_reference`
- `cut_structure_reference`
- `pacing_reference`
- `effect_reference`
- `environment_reference`
- `character_reference`
- `audio_source_with_video`

### 6.3 Audio roles

- `voice_timbre_reference`
- `voice_delivery_reference`
- `dialogue_content_reference`
- `audio_reuse_full`
- `audio_reuse_partial`
- `music_style_reference`
- `music_reuse`
- `sound_effect_reference`
- `ambience_reference`
- `beat_or_rhythm_reference`

### 6.4 Preservation strengths

Expose a simple UI, but map it to precise internal semantics:

| UI choice | Internal behavior |
|---|---|
| Exact | Fully preserve or copy when technically applicable |
| Strong | Preserve defining attributes; minor incidental variation allowed |
| Guide | Transfer the requested attribute without copying unrelated content |
| Inspiration | Weak reference for broad style or atmosphere |

## 7. System prompt for the prompt-generation model

The following is a recommended starting system prompt for the LLM that converts the intermediate plan into H3-native output. It should be paired with structured input and validators rather than used alone.

```text
You are a specialist prompt compiler for the MiniMax-H3 multimodal audio-video generation model.

Your task is to transform a validated generation plan into one production-ready MiniMax H3 prompt. Follow the official H3 format for the selected mode exactly.

General rules:
1. Write all structural prose in English. Preserve the original language only inside dialogue or lyrics enclosed by <d> tags and inside exact visible on-screen text.
2. Preserve the user's intent, exact dialogue, visible text, hard constraints, reference roles, and ending condition.
3. Never invent product claims, technical functions, brand wording, quoted speech, legal wording, or reference attributes not supported by the input.
4. Describe video in playback order. Make actions physically observable and temporally plausible for the requested duration.
5. Give every reference asset an explicit role. Do not allow a label to change meaning between sections.
6. Prefer one coherent camera plan per shot. Express camera movement in natural English using motion type and, when meaningful, amplitude and speed.
7. Use cuts only when they introduce new information. Shot 1 has no timestamp. Later shots have strictly increasing timestamps in the form MM:SS.mmm and must occur before the video ends.
8. Keep subject identity, clothing, product geometry, important objects, colors, and spatial relationships consistent unless the plan explicitly changes them.
9. Put dialogue and singing in the shot timeline. Assign stable speaker IDs such as (S1) and (S2). Put only the language tag and exact words inside <d>[Language] ...</d>.
10. Separate physical/ambient sound from audience-only music. Do not repeat dialogue in overall_soundscape.
11. Use N/A for non_diegetic_music when no audience-only score is requested.
12. Do not add explanations, alternatives, Markdown headings, or commentary around the final H3 prompt.

Mode rules:

T2VA:
Output exactly these three fields in order:
integrated_multimodal_description
overall_soundscape
non_diegetic_music

I2VA:
Begin with exactly:
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
Then output the three base fields. Begin from the image and develop forward while preserving its identity, clothing, objects, composition, and spatial anchors.

FL2VA:
Begin with the official picture-alignment sentence using Picture 1 at 0.00 seconds and Picture 2 at the exact target duration formatted to two decimal places. Use the actual final shot number. Describe a continuous physical path from the opening image to the ending image. Prefer one shot unless the plan explicitly requires cuts.

L2VA:
Begin with the official picture-alignment sentence placing <Picture 1> at the exact target duration formatted to two decimal places and in the actual final shot. Infer a plausible earlier state, then converge visibly onto the reference ending.

Ref2VA:
Output exactly these six sections in order:
subject_definitions
summary
retention_analysis
detailed_description
overall_soundscape
non_diegetic_music
Use <Subject N>, <Picture N>, <Video N>, and <Audio N> consistently. Begin summary with the correct task-type markers. Use only the official retention markers supplied by the plan.

Before writing, silently verify:
- the selected mode matches the supplied assets;
- no first/last-frame role is mixed with reference roles;
- all shot times are valid;
- all labels are defined and stable;
- the ending condition is achieved;
- exact dialogue and visible text are unchanged.

Return only the final MiniMax H3 prompt.
```

## 8. User-facing intake design

A useful assistant should accept a casual brief such as:

> A cinematic product clip showing our machine processing a wafer. Use this machine image, make it futuristic, perhaps 10 seconds.

It should then ask only questions that materially change the generation:

1. **What should the image do?** Exact first frame, machine reference, composition reference, or style reference?
2. **What must happen?** For example: doors open, wafer enters, stage aligns, status light changes, or abstract light travels through the system?
3. **What final moment matters?** Product hero frame, completed process, logo, or operator reaction?
4. **Where will it be used?** Website 16:9, LinkedIn 1:1/4:3, vertical social 9:16, or another format?
5. **Should H3 create sound?** Machine ambience, voiceover, music, silence, or a combination?

When reasonable, infer defaults and let the user edit them:

- 8 seconds for a simple product reveal;
- one or two shots;
- 16:9 for general web/video use;
- restrained camera movement for technical products;
- no dialogue unless requested;
- product geometry and labels as strong preservation constraints.

## 9. Prompt-length strategy

The direct API caps prompts at 7,000 characters. The official Ref2VA format can become long, so implement a compression pass.

Recommended compression priority:

1. Remove duplicate adjectives.
2. Remove details unrelated to visible or audible output.
3. Avoid redefining subjects after their first detailed appearance.
4. Merge repeated continuity statements.
5. Shorten decorative environmental detail.
6. Keep exact dialogue, visible text, reference roles, action path, camera plan, and ending condition intact.
7. Never truncate by raw character slicing; it may break tags, labels, timestamps, or final-state instructions.

Use separate budgets:

- T2VA/I2VA/L2VA/FL2VA: usually concise unless the scene is complex.
- Ref2VA: allocate more space to definitions, retention relationships, and target timeline.

## 10. Anti-patterns and corrections

### 10.1 Keyword soup

Bad:

> Cinematic, epic, 8K, hyperreal, beautiful, masterpiece, dramatic, luxury, high detail.

Better:

> Live-action product film on a dark neutral stage. A narrow overhead softbox creates a controlled highlight along the brushed metal housing while the background remains two stops darker. The camera arcs clockwise with small amplitude at slow speed as the access module closes.

### 10.2 No temporal development

Bad:

> A scientist in a cleanroom beside a semiconductor machine.

Better:

> The scientist begins beside the closed process chamber, checks the control display, then turns toward the machine as the chamber indicator changes from amber to green. She raises her gaze to the illuminated wafer stage while the camera slowly pushes in.

### 10.3 Unassigned references

Bad:

> Reference all uploaded materials.

Better:

> Image 1 defines the machine’s geometry and logo placement. Image 2 defines the cleanroom lighting and color palette. Video 1 supplies only the camera’s slow left-to-right truck and must not transfer its people or background.

### 10.4 Conflicting camera directions

Bad:

> Static locked camera that rapidly orbits and zooms into the subject.

Better:

> The camera remains static for the first two seconds, then begins a slow push in with small amplitude. No orbit or handheld movement.

### 10.5 Excessive action density

Bad for a five-second clip:

> The character enters, changes clothes, runs through three rooms, speaks two sentences, opens a case, reveals a product, and the building transforms.

Correction:

- increase duration;
- reduce events;
- split into multiple clips;
- select one decisive action and one ending.

### 10.6 Abstract music direction

Bad:

> Inspiring futuristic music.

Better:

> Sparse electronic pulse at a moderate tempo with soft granular textures and a restrained low synth bass; the pulse increases slightly in density during the reveal and ends on a short sustained tone.

### 10.7 Negative-prompt overload

H3 is designed for natural-language instruction following. Prefer positive, concrete direction and a short list of essential prohibitions.

Instead of:

> No warping, no flicker, no distortion, no extra fingers, no bad anatomy, no strange lighting, no camera shake, no blur, no low quality...

Use:

> Preserve the product’s exact geometry, panel seams, logo placement, and proportions throughout. Use a stable tripod-like camera with no handheld shake. Keep the label sharp and readable in the final hero frame.

### 10.8 Treating a style reference as a source video edit

If the user wants only the rhythm or camera behavior of a video, classify it as reference generation, not video editing. Reserve editing for requests that directly modify the source video.

## 11. Example: text-only product film

### Input brief

> Create an eight-second cinematic clip of a precision machine aligning a wafer. Dark technical environment, no people, sophisticated but realistic, with sound.

### H3-optimized output

```text
integrated_multimodal_description: [Shot 1] Live-action, cinematic product film, a medium-wide eye-level shot frames a precision wafer-processing machine in a dark, controlled technical environment. The machine has a matte graphite housing, brushed-metal edges, a circular illuminated wafer stage, and restrained cyan status lights. The camera pushes in with small amplitude at slow speed as a polished silicon wafer glides horizontally into the open process area on a robotic transfer arm. The arm decelerates smoothly and lowers the wafer onto the circular stage. Fine alignment markers around the stage illuminate one after another while the wafer rotates a few degrees clockwise, pauses, then makes a precise counterclockwise correction. [Shot 2] At 00:05.000, the camera cuts to a close-up of the wafer edge and alignment mechanism. A narrow scanning line passes across the reflective surface, the final alignment marker changes from amber to green, and the mechanism becomes completely still. The final frame holds on the precisely centered wafer and the green status light.

overall_soundscape: A steady low ventilation hum fills the technical space. Quiet servo motors move the transfer arm, followed by precise mechanical clicks as the wafer settles and a short electronic confirmation tone when alignment completes.

non_diegetic_music: Sparse electronic pulses at a moderate tempo with soft granular textures and a restrained low synth bass, increasing slightly in density during alignment and ending on a short sustained tone.
```

## 12. Example: image as exact first frame

### Role decision

- Image 1 is the exact first frame.
- The subject, clothing, composition, and environment must remain consistent.
- Motion develops forward from the still image.

### H3-optimized output pattern

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, the engineer shown in <Picture 1> remains in the same cleanroom position beside the machine, preserving facial identity, white cleanroom suit, transparent protective glasses, machine geometry, lighting, and initial composition. The camera trucks right with small amplitude at slow speed as the engineer turns toward the control panel and raises the right hand. The gloved index finger touches the illuminated interface, causing one circular control to change from blue to green. The engineer lowers the hand and looks through the chamber window as the internal wafer stage begins a slow, precise rotation. The final frame holds on the engineer observing the active process.

overall_soundscape: Low cleanroom ventilation continues throughout. Fabric rustles softly as the engineer moves, followed by a muted interface tap, a short confirmation tone, and the smooth mechanical hum of the rotating stage.

non_diegetic_music: Minimal electronic score with widely spaced glass-like tones over a quiet low-frequency pulse, remaining restrained throughout.
```

## 13. Example: reference-led product advertisement

### Asset assignment

- Image 1: product geometry, materials, labels, and logo.
- Image 2: environment and lighting.
- Video 1: camera movement and pacing only.
- Audio 1: music-style reference only, not direct reuse.

### Ref2VA structural pattern

```text
subject_definitions:
<Subject 1> is the product from <Picture 1>, preserving its exact rectangular housing, brushed-aluminum front plate, dark glass display, control-button positions, printed labels, proportions, and logo placement.
<Subject 2> is the technical presentation environment from <Picture 2>, with a clean dark-grey platform, narrow overhead lighting, and a soft gradient background.
<Video 1> provides only the slow clockwise arc-shot movement and restrained pacing for the target video; its people, products, and background are not transferred.
<Audio 1> is a music-style reference providing a sparse electronic rhythm and restrained low-frequency texture without directly copying the source signal.

summary:
[reference generation + audio reference] The target video presents <Subject 1> in <Subject 2>, using the camera movement and pacing of <Video 1> and the restrained electronic music style of <Audio 1>. The product activates, reveals its interface, and ends in a stable hero composition.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - the product geometry, materials, display, control positions, labels, proportions, and logo placement remain consistent.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - the presentation platform, overhead lighting, and gradient background are retained.
<Video 1> (camera movement and pacing): attribute_transfer - only the slow clockwise arc movement and restrained timing are transferred to the target product scene.
<Audio 1>: reference - its sparse electronic rhythm and low-frequency texture guide the score without copying the original audio signal.

detailed_description:
The target video is a realistic, restrained industrial product film with precise lighting and controlled motion.
[Shot 1] A medium-wide shot establishes <Subject 1> centered on the presentation platform in <Subject 2>. The product preserves the exact housing, brushed-aluminum front plate, dark glass display, control-button positions, printed labels, proportions, and logo placement defined by <Picture 1>. Following the camera behavior of <Video 1>, the camera begins a slow clockwise arc shot with small amplitude while the product remains completely still. A narrow overhead highlight travels naturally across the aluminum surface as the viewing angle changes. Midway through the shot, the display wakes from black to a restrained blue interface, followed by a thin green status line moving once from left to right.
[Shot 2] At 00:05.000, the shot cuts to a close-up of the front display and logo. The camera continues the final portion of the slow arc movement from <Video 1> while the interface settles into a clean status screen. A small indicator beside the main control changes from blue to green. The camera stops, the product remains perfectly still, and the final frame holds a sharp three-quarter hero view with the logo and printed labels readable.

overall_soundscape:
A quiet studio-like room tone sits beneath a subtle electrical activation sound, one soft interface sweep, and a restrained confirmation tone as the indicator changes to green.

non_diegetic_music:
The score references <Audio 1> through a sparse electronic rhythm at a moderate tempo, a restrained low synth pulse, and thin granular accents. The music increases slightly in density during activation and resolves into one sustained tone for the final hero frame.
```

## 14. Testing and evaluation strategy

Prompt quality should be measured from generated outputs, not from how impressive the prompt sounds.

### 14.1 Build a benchmark set

Include at least these cases:

- simple text-to-video action;
- realistic product reveal;
- image-to-video with subtle human motion;
- first-and-last-frame physical transition;
- last-frame landing;
- multi-image character and wardrobe preservation;
- product geometry and logo preservation;
- motion transfer from video;
- camera transfer from video;
- source-video editing;
- source-video continuation;
- voice-timbre reference;
- direct audio reuse;
- dialogue with two speakers;
- voiceover with closed lips;
- visible text;
- vertical social-video output;
- prompt near the 7,000-character limit;
- conflicting references;
- underspecified user idea.

### 14.2 Score each output

Use a structured rubric from 0 to 5:

| Dimension | Evaluation question |
|---|---|
| Intent fidelity | Does the output communicate the requested idea? |
| Subject consistency | Is identity or product geometry preserved? |
| Reference-role fidelity | Did each asset influence only the intended attributes? |
| Action completion | Does the requested action occur clearly and finish? |
| Timeline coherence | Are movement and cuts temporally coherent? |
| Camera adherence | Does camera behavior match the prompt? |
| Final-state adherence | Does the clip land on the required ending? |
| Dialogue accuracy | Are words, speaker, timing, and lip behavior correct? |
| Sound adherence | Are ambience, effects, and music appropriate and separated? |
| Text/brand accuracy | Are labels, logos, and visible text correct? |
| Artifact severity | Are there visible or audible generation failures? |
| Prompt efficiency | Was the result achieved without unnecessary complexity? |

### 14.3 Compare prompt strategies

For each benchmark, compare:

1. Raw user idea.
2. Generic cinematic expansion.
3. Your structured H3 compiler.
4. Official H3-Context-IR output.
5. Your compiler followed by H3-Context-IR, if the API accepts the workflow cleanly.

Run multiple seeds or generations per condition. A single output is not sufficient because generation is stochastic.

### 14.4 Capture failure attribution

When a result fails, distinguish:

- mode-selection failure;
- asset-role failure;
- media-analysis failure;
- prompt-compilation failure;
- contradiction-resolution failure;
- API validation failure;
- model adherence limitation;
- stochastic generation failure;
- source-asset quality problem.

This prevents repeatedly “improving the prompt” when the real issue is an incompatible reference, insufficient duration, or wrong generation mode.

## 15. Recommended product architecture

```text
User idea + optional media
        ↓
Media inspection and metadata validation
        ↓
Intent extraction
        ↓
Asset-role assignment
        ↓
Mode router
        ↓
Clarification or explicit assumptions
        ↓
Structured generation plan
        ↓
Constraint and timeline validator
        ↓
H3 prompt compiler
        ↓
Prompt validator and character-budget compressor
        ↓
Optional H3-Context-IR enhancement
        ↓
User preview: prompt + assumptions + asset map
        ↓
MiniMax H3 generation API
        ↓
Output evaluation and revision suggestions
```

Recommended service separation:

- **Media analyzer:** extracts visual, temporal, and audio features.
- **Intent planner:** turns the idea into a constrained shot plan.
- **Mode router:** selects T2VA/I2VA/L2VA/FL2VA/Ref2VA.
- **Prompt compiler:** renders official H3 syntax.
- **Validator:** checks format, references, timeline, and API constraints.
- **Evaluator:** compares generated output against the plan.
- **Revision engine:** changes only the failed dimensions rather than rewriting everything.

## 16. Revision logic after generation

Let the user identify the failure, then modify the relevant layer.

| Failure | Revision strategy |
|---|---|
| Face or product changes | Strengthen identity/geometry anchors; reduce unrelated visual invention |
| Wrong reference influence | Narrow asset role; explicitly exclude unrelated source attributes |
| Motion too weak | Make action onset, intermediate states, and endpoint more observable |
| Motion too chaotic | Reduce actions; use one camera move; stabilize environment |
| Final frame wrong | Add a precise ending condition and final hold |
| Too many cuts | Merge shots and replace cuts with camera motion |
| Dialogue inaccurate | Shorten line, preserve exact wrapper, reduce competing actions |
| Lip movement during voiceover | Explicitly state off-screen voiceover and closed lips |
| Sound generic | Add concrete sources, timing, and physical relationships |
| Music overwhelms dialogue | Specify lower music level conceptually and simpler instrumentation |
| Text unreadable | Reduce text quantity, require a stable close or hero frame, preserve exact string |
| Reference mismatch | Reassess whether source and target body, pose, composition, or timing are compatible |

## 17. Practical recommendations for the first product version

For an MVP, implement:

1. Text idea input.
2. Upload of images and videos, with audio supported next.
3. Explicit role selector for every asset.
4. Duration and aspect-ratio controls.
5. Three creative-freedom levels.
6. Dialogue and visible-text fields.
7. Structured plan generation.
8. Base-mode and Ref2VA prompt compilation.
9. Deterministic validator.
10. Copyable final prompt plus optional API request payload.
11. Optional H3-Context-IR call.
12. A revision interface organized by identity, action, camera, ending, sound, and text.

Defer advanced automatic editing decisions until you have benchmark data. In particular, source-video editing, continuation, partial audio reuse, speech crossing cuts, and complex multi-reference conflict resolution deserve dedicated tests.

## 18. Final checklist

Before returning an H3 prompt, confirm:

- [ ] The H3 mode is explicit and correct.
- [ ] Every asset has a defined role.
- [ ] First/last-frame roles are not mixed with reference roles.
- [ ] The prompt describes change over time.
- [ ] The main subject, action, and ending are explicit.
- [ ] Shot count fits the duration.
- [ ] Cut timestamps are valid and increasing.
- [ ] Camera motion is physically coherent.
- [ ] Subject identity or product geometry has concrete anchors.
- [ ] Dialogue is exact and uses stable speaker IDs.
- [ ] Voiceover explicitly keeps visible lips closed.
- [ ] Visible text is exact and quoted.
- [ ] Ambient/physical sound is separate from audience-only music.
- [ ] Reference labels are defined and stable.
- [ ] Ref2VA uses the six official sections in order.
- [ ] The final frame communicates the intended outcome.
- [ ] The direct-generation prompt is within 7,000 characters.
- [ ] Duration, ratio, resolution, and media fit API constraints.
- [ ] Assumptions are disclosed to the user outside the raw H3 prompt.
- [ ] The UI does not claim deterministic perfection.

## Sources and further reading

### Primary MiniMax sources

1. [MiniMax H3: An Open Model Breaking the Boundaries Between Tasks and Modalities](https://www.minimax.io/blog/minimax-h3)
2. [Open General Intelligence: MiniMax H3 Is Now Open Source](https://www.minimax.io/news/minimax-h3-open-source)
3. [MiniMax API: Video Generation Guide](https://platform.minimax.io/docs/guides/video-generation)
4. [MiniMax API: H3 Feature Highlights](https://platform.minimax.io/docs/guides/video-prompt)
5. [MiniMax API: Create Video Generation Task](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)
6. [MiniMax API: Create H3-Context-IR Task](https://platform.minimax.io/docs/api-reference/video-generation-v2-h3-context-ir)
7. [Official Video Prompt Writing Guide: T2VA / I2VA / FL2VA / L2VA](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)
8. [Official Full-Reference Mode Rewrite Output Format Guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)

### Secondary implementation-oriented references

These are useful for examples and cross-checking, but the official MiniMax documentation should take precedence when guidance conflicts:

- [fal: MiniMax H3 Prompting Guide](https://fal.ai/learn/devs/minimax-h3-prompting-guide)
- [RunDiffusion: MiniMax H3 Prompt Guide](https://www.rundiffusion.com/minimax-h3-prompt-guide)
- [Pixo: MiniMax H3 Prompt Guide](https://pixo.video/blog/minimax-h3-prompt-guide)

---

**Bottom line:** The most reliable H3 prompt assistant is not a prose beautifier. It is a multimodal intent compiler: it identifies the generation mode, assigns each asset a precise role, plans a feasible audiovisual timeline, renders the official H3 structure, validates it deterministically, and then helps the user revise the dimensions that actually failed in the generated result.
