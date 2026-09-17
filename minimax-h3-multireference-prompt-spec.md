# MiniMax H3 Multiframe / Multireference Prompt Specification

## Purpose

This document describes how a prompt enhancer should prepare prompts for the current MiniMax H3 multiframe Reference-to-Video workflow in ComfyUI.

The workflow combines:

- Reference images that define identity, appearance, environment, clothing, objects, or style.
- A first reference image that normally establishes the opening frame.
- Chained `Add Guide` nodes that anchor a target composition at specific points in the output timeline.
- A structured full-reference prompt that explains the subjects, reference roles, timeline, camera, actions, and audio.

The official ComfyUI workflow uses a Reference-to-Video node together with chained Add Guide nodes. Each Add Guide anchors an image, and optionally audio, at a selected frame index. The workflow documentation is available at:

- https://docs.comfy.org/tutorials/video/minimax/minimax-h3-multiframe
- https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide
- https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md

## 1. Core mental model

There are two separate kinds of control:

### Semantic references

Semantic references tell H3 what content should be preserved or reused:

- A person's identity
- Clothing and hairstyle
- An environment
- A machine or product
- A visual style
- A voice or audio characteristic
- A reference video's camera or temporal structure

These are represented in the prompt with labels such as `<Subject 1>`, `<Picture 1>`, `<Video 1>`, and `<Audio 1>`.

### Timeline guides

Timeline guides tell H3 what the composition should look like at a particular moment:

- The person's pose and action at that moment
- The camera angle and framing
- The background and object placement
- A transition target or storyboard state

An Add Guide image connected only to an Add Guide node is a timeline anchor. It is not automatically exposed to the text encoder as a `<Picture N>` tag. If the prompt should refer to that image explicitly, connect the same image to a `ref_images` slot as well.

The result is best understood as storyboard-controlled Ref2V:

```text
Reference images  = who and what should remain consistent
Add Guide images  = what the scene should reach at selected times
Prompt            = how the scene, subjects, actions, camera, and sound are related
```

An Add Guide is not automatically a hard cut. Unless the user explicitly requests a cut, describe the target as a continuous transition that reaches the guide composition.

## 2. Reference labels and ordering

Reference labels are assigned according to connection order, not filename or semantic importance.

### Image references

- First image connected to `ref_images`: `<Picture 1>`
- Second image connected to `ref_images`: `<Picture 2>`
- Third image connected to `ref_images`: `<Picture 3>`

### Video references

- First reference video: `<Video 1>`
- Second reference video: `<Video 2>`

### Audio references

- First standalone reference audio: `<Audio 1>`
- Second standalone reference audio: `<Audio 2>`

The prompt enhancer must never invent a reference tag that is not present in the workflow metadata.

A picture can play two roles:

1. A semantic reference for identity, appearance, environment, or style.
2. A concrete frame anchor or storyboard keyframe.

If it plays both roles, describe both roles in `subject_definitions` and `detailed_description`.

## 3. Timeline and frame conversion

The multiframe workflow uses 24 frames per second for Add Guide frame positions.

```text
frame_idx = round(time_seconds * 24)
```

Examples:

| Time | Frame index |
|---:|---:|
| 0.0 s | 0 |
| 1.5 s | 36 |
| 3.0 s | 72 |
| 5.0 s | 120 |

The prompt enhancer should keep both representations in its internal data:

```json
{
  "time_seconds": 1.5,
  "frame_idx": 36,
  "reference_tag": "<Picture 2>"
}
```

Validate that the guide frame and its guide length remain inside the generated duration. Also validate the total output length against the model's supported temporal grid before generating the ComfyUI workflow.

## 4. Required prompt structure

For full-reference mode, generate exactly these six sections in this order:

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

The section names should remain exactly as shown. The main descriptive text should be in English. Preserve the original language only for:

- Dialogue inside `<d>...</d>`
- Lyrics inside `<d>...</d>`
- Text visibly present in the generated scene

## 5. Section-by-section rules

### 5.1 `subject_definitions`

Define every important reusable subject and every reference label that needs to be tracked later.

Use `<Subject N>` for reusable visible content:

- People
- Animals
- Machines
- Products
- Environments
- Clothing
- Props
- Styles or visual effects

Use `<Picture N>` when the image is a concrete frame, keyframe, or composition anchor.

Use `<Video N>` for a whole-video relationship such as continuation, editing, camera movement, cuts, pacing, or temporal structure.

Use `<Audio N>` for copied or referenced audio.

Each definition should explain:

- What the label represents
- Which reference asset supplies it
- The visual or audio characteristics to preserve
- Its role in the target video

Good examples:

```text
<Subject 1> is the same woman shown in <Picture 1>, <Picture 2>, and <Picture 3>, with shoulder-length dark hair, a navy blazer, a white blouse, and a silver pendant. Preserve her identity, facial features, hairstyle, clothing, and body proportions across the full video.

<Subject 2> is the semiconductor inspection machine shown in <Picture 1> and <Picture 3>, including its white enclosure, dark front panel, robotic handling arm, and blue status light.

<Subject 3> is the cleanroom environment shown in <Picture 1>, with bright neutral lighting, pale walls, reflective flooring, and a controlled industrial atmosphere.

<Picture 1> is the first frame of the target video and establishes the woman's identity, the cleanroom, and the machine.

<Picture 2> is a storyboard keyframe for the target composition at 00:01.500, showing the woman walking toward the machine.

<Picture 3> is a storyboard keyframe for the target composition at 00:03.000, showing the woman opening the machine panel.
```

Do not create a `<Picture N>` entry for a guide-only image that is not connected to `ref_images`. In that case, the guide still controls the timeline through the Add Guide node, but the text encoder cannot identify it through a picture tag.

### 5.2 `summary`

Write one short English paragraph beginning with a bracketed task type.

For a normal multiframe generation using images as concrete frame anchors, use:

```text
[keyframe completion + reference generation]
```

Use only the task types that actually apply:

- `keyframe completion`: an image defines a first frame, keyframe, or last frame
- `reference generation`: an asset guides identity, scene, style, action, camera, or other content without being directly edited or continued
- `video editing`: an existing video is directly modified
- `video continuation`: new content continues an existing video
- `audio reuse`: the source audio is copied into the final output
- `audio reference`: only timbre, rhythm, delivery, style, or sound texture is used

Example:

```text
[keyframe completion + reference generation] The target video shows <Subject 1> moving through the cleanroom and interacting with <Subject 2>. <Picture 1> establishes the opening composition and identity, while <Picture 2> and <Picture 3> define later storyboard states that the continuous action reaches at 00:01.500 and 00:03.000.
```

Do not describe a timeline guide as a hard cut unless the user explicitly requested a hard cut.

### 5.3 `retention_analysis`

Write one line for each important reference label. Explain where it appears and what is preserved.

For visible references, use one of:

- `fully_preserved`
- `partially_preserved`
- `attribute_transfer`
- `weak_reference`

For audio, use one of:

- `fully_copy`
- `partially_copy`
- `reference`
- `weak_reference`

Example:

```text
<Subject 1> (appears throughout the video): fully_preserved - preserve the woman's identity, facial features, hairstyle, navy blazer, white blouse, and silver pendant.

<Subject 2> (appears in the opening and final compositions): fully_preserved - preserve the machine's enclosure, front panel, robotic arm, and blue status light.

<Subject 3> (appears throughout the video): fully_preserved - preserve the cleanroom lighting, reflective floor, pale walls, and industrial atmosphere.

<Picture 1> ([Shot 1] first frame): fully_preserved - preserve the opening composition and initial subject placement.

<Picture 2> ([Shot 2] target composition at 00:01.500): fully_preserved - use the image as the intended pose, framing, and scene-state target at that time.

<Picture 3> ([Shot 3] target composition at 00:03.000): fully_preserved - use the image as the intended panel-opening composition and subject placement at that time.
```

Do not treat a new action, camera move, or transition as a reference failure. Evaluate preservation only against the role defined for the reference.

### 5.4 `detailed_description`

This is the most important section. It should describe the video in playback order and include:

- Overall visual style
- Scene and environment
- Subject appearance and position
- Actions and state changes
- Camera framing and movement
- Timeline anchor times
- Sound and dialogue
- Reference labels at their first relevant appearance

Start with one or two sentences establishing the overall style before `[Shot 1]`.

Use `[Shot N]` blocks. The first shot has no timestamp. Later blocks use a timestamp:

```text
[Shot 1] ...
[Shot 2] At 00:01.500, ...
[Shot 3] At 00:03.000, ...
```

For a continuous multiframe transition, use wording such as:

```text
At 00:01.500, the continuous movement reaches the composition defined by <Picture 2>.
```

For an explicit hard cut, use:

```text
At 00:01.500, the video cuts to the composition defined by <Picture 2>.
```

The enhancer should use the second form only when the user asks for a cut or clearly describes separate shots.

At the first appearance of an important subject, describe its visible characteristics and position. Later references can use the same label without redefining it.

Example:

```text
The target video uses a realistic cinematic corporate-industrial style with clean neutral lighting, restrained colors, and smooth physically plausible motion.

[Shot 1] The video begins from <Picture 1>. <Subject 1>, the woman with shoulder-length dark hair, a navy blazer, a white blouse, and a silver pendant, stands in the left half of the frame beside <Subject 2>, the white semiconductor inspection machine. <Subject 3>, the bright cleanroom environment, fills the background with pale walls and reflective flooring. The camera holds a medium-wide shot at eye level and begins a slow forward dolly. The woman looks toward the machine and takes her first step forward.

[Shot 2] At 00:01.500, the continuous movement reaches the composition defined by <Picture 2>. The woman is now closer to the machine, positioned in three-quarter profile with her right hand beginning to reach toward the front panel. The camera continues the slow dolly and subtly pans right to keep her and the machine balanced in frame. Preserve the transition between the opening pose and this keyframe rather than introducing a jump cut.

[Shot 3] At 00:03.000, the continuous movement reaches the composition defined by <Picture 3>. The woman stands directly in front of the machine with one hand on the panel handle. She opens the panel carefully and looks inside. The camera moves to a closer over-the-shoulder angle, keeping the machine interface visible while preserving the woman's identity and clothing.

[Shot 4] At 00:05.000, the camera settles into a stable medium shot. The woman finishes opening the panel, pauses, and examines the interior. The machine's status light remains blue, the cleanroom stays visually consistent, and the final frame holds the established industrial composition without introducing new people or objects.
```

### 5.5 `overall_soundscape`

Describe ambience and physical sounds across the video:

```text
overall_soundscape:
A quiet cleanroom ambience continues throughout, with a soft ventilation hum, restrained servo movement from the machine, light footsteps on the reflective floor, and a subtle panel mechanism sound when the door opens.
```

Do not repeat complete dialogue here. Shot-specific sounds belong in `detailed_description`.

### 5.6 `non_diegetic_music`

Describe audience-only background music. If there is no music, write `N/A`.

Example:

```text
non_diegetic_music:
A restrained electronic-industrial score at a slow tempo, with soft synthesizer pads and a minimal pulse that remains understated throughout the video.
```

## 6. Prompt-enhancer algorithm

The prompt enhancer should follow this sequence.

### Step 1: Normalize the user request

Extract:

- Main subjects
- Identity constraints
- Clothing and appearance
- Environment
- Objects and machines
- Actions
- Camera movement
- Desired style
- Audio and dialogue
- Timeline events
- Whether transitions should be continuous or hard cuts

Do not invent missing character names, reference assets, dialogue, or exact timestamps.

### Step 2: Normalize the workflow metadata

Create an internal reference registry:

```json
{
  "pictures": [
    {
      "tag": "<Picture 1>",
      "asset_id": "image_001",
      "connected_to_ref_images": true,
      "connected_to_add_guide": true,
      "role": "identity_and_first_frame",
      "time_seconds": 0.0,
      "frame_idx": 0
    },
    {
      "tag": "<Picture 2>",
      "asset_id": "image_002",
      "connected_to_ref_images": true,
      "connected_to_add_guide": true,
      "role": "timeline_keyframe",
      "time_seconds": 1.5,
      "frame_idx": 36
    }
  ],
  "subjects": [],
  "videos": [],
  "audios": []
}
```

Assign tags from connection order. Never assign tags based on a user-facing name such as `woman_final.png`.

### Step 3: Decide task types

For each asset, determine whether it is:

- A concrete frame anchor
- A semantic reference
- A source video for editing or continuation
- An audio copy source
- An audio style or voice reference

Build the summary prefix from the actual roles.

### Step 4: Build subject definitions

Group multiple assets that describe the same target subject. For example, several pictures may define the same woman. Keep the subject label stable across all sections.

Prefer one subject definition such as:

```text
<Subject 1> is the same woman whose identity comes from <Picture 1>, whose clothing is confirmed by <Picture 2>, and whose target action and composition are shown by <Picture 3>.
```

Do not create separate subjects merely because the same person appears in several images.

### Step 5: Build the timeline

Sort guide events by frame index. For each event, generate:

- Shot number
- Timestamp
- Frame index for workflow metadata
- Target picture tag, only if the image is also a `ref_images` reference
- Intended state
- Transition wording

### Step 6: Generate the six sections

Always output the six sections in the required order. Keep labels consistent. Use the same subject and picture definitions everywhere.

### Step 7: Validate the output

Check:

- All six sections exist and are correctly ordered.
- All reference tags exist in the workflow registry.
- No picture tag is used for a guide-only image unless it is also connected to `ref_images`.
- Picture numbering follows connection order.
- Timeline events are sorted chronologically.
- Timestamps and frame indices agree.
- Dialogue uses `<d>[Language] ...</d>`.
- Visible on-screen text is written in English double quotes.
- `fully_copy` is used only when audio is copied directly.
- The same subject label is not reassigned to another person or object.
- No hard cut is implied when the user requested a continuous transition.
- No unsupported details are invented.

## 7. Recommended internal data model

Use a structured intermediate representation before rendering the final prompt:

```typescript
type PictureReference = {
  tag: string;                 // <Picture 1>
  assetId: string;
  connectionIndex: number;
  inRefImages: boolean;
  inAddGuide: boolean;
  role: "identity" | "first_frame" | "keyframe" | "last_frame" | "style" | "environment";
  timeSeconds?: number;
  frameIdx?: number;
  description?: string;
};

type SubjectDefinition = {
  tag: string;                 // <Subject 1>
  description: string;
  sourceTags: string[];
  preservation: "fully_preserved" | "partially_preserved" | "attribute_transfer" | "weak_reference";
};

type TimelineAnchor = {
  shotNumber: number;
  timeSeconds: number;
  frameIdx: number;
  pictureTag?: string;
  guideAssetId: string;
  stateDescription: string;
  transition: "continuous" | "hard_cut";
};
```

## 8. Minimal reusable template

```text
subject_definitions:
<Subject 1> is [the main person/object/environment], defined by [reference tags]. Preserve [important attributes].
<Subject 2> is [second subject], defined by [reference tags]. Preserve [important attributes].
<Picture 1> is the first frame of the target video and establishes [opening state].
<Picture 2> is the storyboard keyframe at [time] showing [target state].

summary:
[keyframe completion + reference generation] The target video shows [main action]. <Picture 1> establishes the opening composition, while <Picture 2> defines the later target state at [time].

retention_analysis:
<Subject 1> (appears in [shots]): fully_preserved - preserve [attributes].
<Subject 2> (appears in [shots]): fully_preserved - preserve [attributes].
<Picture 1> ([Shot 1] first frame): fully_preserved - preserve [opening composition].
<Picture 2> ([Shot N] target composition at [time]): fully_preserved - use it as the target [pose, framing, and scene state].

detailed_description:
The target video uses [visual style].
[Shot 1] The video begins from <Picture 1>. [Describe scene, subjects, positions, action, camera, and sound.]
[Shot 2] At [time], the [continuous transition reaches / video cuts to] the composition defined by <Picture 2>. [Describe the new state and continuing action.]
[Shot N] At [time], [describe final state, camera, and action.]

overall_soundscape:
[Describe ambience and physical sounds.]

non_diegetic_music:
[Describe audience-only music, or write N/A.]
```

## 9. Common mistakes to prevent

### Mistake: treating every guide image as a text-visible picture reference

Correction: a guide-only image is not automatically a `<Picture N>`. It must also be connected to `ref_images` if the prompt needs to refer to it by tag.

### Mistake: using filenames as picture numbers

Correction: picture numbers follow `ref_images` connection order.

### Mistake: describing keyframes without explaining their timing

Correction: explicitly state the target time in `subject_definitions`, `summary`, and `detailed_description` where appropriate.

### Mistake: writing only a short plot summary

Correction: describe composition, subject position, environment, lighting, actions, state changes, camera movement, and sound.

### Mistake: using a new subject label for every image of the same person

Correction: merge those assets into one stable `<Subject N>` definition.

### Mistake: turning every timestamp into a cut

Correction: use continuous-transition wording unless the user explicitly requests cuts.

### Mistake: adding imagined content

Correction: preserve the user's intent and reference metadata. If a detail is unknown, describe it at a safe level of abstraction rather than inventing a specific fact.

## 10. Short implementation instruction for Claude Code

Use the following as a high-level implementation brief:

```text
Implement a MiniMax H3 multiframe prompt enhancer.

Input:
1. User's natural-language video request.
2. Ordered reference-image metadata.
3. Ordered reference-video metadata.
4. Ordered reference-audio metadata.
5. Add Guide metadata containing guide asset IDs, time in seconds, and frame indices.

Output:
A full-reference MiniMax H3 prompt containing exactly these sections in order:
subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music.

Rules:
- Assign <Picture N>, <Video N>, and <Audio N> from connection order.
- Keep stable <Subject N> labels for reusable people, objects, environments, clothing, and styles.
- Treat ref_images as semantic references visible to the text encoder.
- Treat Add Guide-only images as timeline anchors without inventing <Picture N> tags.
- Convert seconds to frame indices with round(seconds * 24).
- Describe first-frame and keyframe roles explicitly.
- Use [keyframe completion + reference generation] for ordinary multiframe reference generation unless another task type is clearly required.
- Use continuous-transition wording for Add Guide anchors unless hard cuts are requested.
- Include detailed shot descriptions with composition, subject placement, action, camera, lighting, sound, and timing.
- Preserve dialogue and lyrics inside <d>[Language] ...</d>.
- Never invent reference tags, dialogue, assets, or unsupported facts.
- Validate tag consistency, timeline order, timestamp/frame agreement, and section completeness before returning the prompt.
```
