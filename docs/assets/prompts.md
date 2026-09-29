# Image generation prompts

Current artwork was created with the built-in ImageGen tool. The redesign uses a 64×64-style 16-bit
adventure-game sprite as its art direction. The PNG files are enlarged masters, not native 64×64
exports. The previous mascot was the concept reference for the redesign; the new mascot was the logo
reference; the logo was the banner edit target.

## mascot.png

```text
Use case: style-transfer.
Asset type: final production pixel-art mascot sprite, designed natively on a strict 64 x 64 logical pixel canvas, displayed as a large nearest-neighbor enlargement for inspection. Transparent background.
Input image 1: OLD mascot, a concept reference only. The user dislikes its crude childlike execution. Keep ONLY the idea of a firefly with a clock abdomen and the navy / amber / cyan family; completely redraw the artwork to professional pixel-art standards. Do not trace the old blocky robot-like proportions.
Primary request: a refined minimal 64x64 sprite of a clockwork firefly for zap-net, a small real Ethereum network with manually controlled protocol time. It must look like a carefully art-directed sprite from a premium 16-bit adventure game, using intentional pixel clusters and economical detail.
Character design: a small poised firefly in a subtle three-quarter view, floating upright at rest. Compact rounded dark teal head, small focused ivory eyes, two elegantly curved stepped antennae with warm tips; no baby face. Narrow thorax. Two tapered swept-back pale cyan wings with just one darker facet each, creating a confident aerodynamic silhouette. Lower body is a beautifully constructed amber clock housing, oval in perspective, with a narrow dark-bronze rim, four minimal dial marks, two crisp dark hands and a tiny winding crown. It glows through palette contrast only. Two tiny tucked legs, no shoes. All these elements must remain simple and readable when reduced to exactly 64x64.
Art direction: balanced mature proportions, less head and more clock than the old reference; clean silhouette; pleasing negative space between wings and body. Use 10 to 12 colors maximum, hue-shifted shadows, restrained one-pixel specular accents. One consistent light source from upper left. Selective dark outline, mostly one logical pixel thick, never the heavy crude all-around border in the reference. Strong designed clusters; details subordinate to the overall silhouette.
Pixel discipline: exactly one regular 64x64 logical grid. Sharp square pixels. Curves made of carefully spaced 1- and 2-pixel steps. Every mark belongs to that grid. No smooth painted textures inside pixel shapes, no blurry glow, no antialiasing, no fake pixel filter, no dithering noise, no gradients, no thick toddler-style outlines. Keep the entire sprite inside a 52x52 area with transparent margins.
Color palette: darkest blue #142333; slate teal #284553; blue teal #416E7D; desaturated cyan #86BFC3; pale cyan #C1E1DB; bronze #86603D; amber #D4973E; warm yellow #F2C65B; ivory #F6E8BE. At most three intermediate solid shades if needed.
Composition: one character only, centered. No scene, no floor, no drop shadow.
Text: none.
Constraints: genuine transparency; no checkerboard painted in, no typography, no extra objects or symbols, no tools, no costume, no gears scattered around, no numbers, no Ethereum logo, no watermark. Minimal and sophisticated, not childish and not over-detailed.
```

## logo.png

```text
Use case: logo-brand.
Asset type: final transparent horizontal logo for zap-net, approximately 3:1 aspect ratio.
Input image 1: the final redesigned mascot, identity reference. Preserve its precise character design, palette, restrained dimensional pixel shading, three-quarter angle and silhouette.
Primary request: produce a refined minimalist pixel-art logo combining this clockwork firefly on the left with the exact wordmark "zap-net" on the right. This is for a professional developer tool; polished restrained 16-bit adventure-game title typography, not a children's game.
Composition: one centered horizontal lockup, generous margins. Mascot roughly 52 logical pixels tall, wordmark x-height roughly 19 logical pixels. Wordmark and mascot optically aligned at center. Comfortable gap between them. Display the lockup as a large crisp nearest-neighbor preview, with consistent square pixels.
Typography: draw "zap-net" in a carefully spaced custom lowercase bitmap typeface, medium weight, about 2 logical pixels of stroke width, modestly condensed with clear counters. Pixel curves have subtle chamfered corners. Clearly readable z, a, p, hyphen, n, e, t. More precise and lighter than a chunky block alphabet. Flat darkest navy #142333 text without outlines, shadows or texture. No extra text.
Mascot invariants: compact teal head with restrained ivory eyes, swept cyan wings, tapered bent glowing antennae, amber clock abdomen with bronze rim, four dial marks, tiny winding crown and tucked legs. Preserve the ref sprite. Do not turn it frontal or redraw it as a flat robot.
Style: disciplined pixel clusters; minimal yet expertly finished. Pixel geometry on a common logical grid, selective thin outline, hue-shifted shadows only in mascot, no blurry effects.
Constraints: genuinely transparent background, no checkerboard painted into output, no frame, no backdrop, no symbols, no tagline, no mockup, no decorative stars, no watermark. All lowercase name exactly "zap-net".
```

## banner.png

```text
Use case: precise-object-edit.
Asset type: final polished minimal README banner for zap-net, wide 3:1 aspect ratio.
Input image 1: final horizontal logo, edit target. Preserve the refined three-quarter-view clockwork firefly sprite and exact lowercase bitmap letter shapes.
Primary request: make a dark-background version of this exact logo. Only two changes: (1) fill the transparent background with uniform deep midnight #142333; (2) recolor the wordmark from dark navy to warm ivory #F6F2E9. Keep the mascot artwork, its deliberate pixel clusters, silhouette, colors, scale and three-quarter angle unchanged. Keep the logo layout and margins unchanged.
Text verbatim: "zap-net". Preserve existing text, do not add text.
Art direction: minimal premium retro 16-bit developer-tool identity. The amber clock and cool wings should read clearly on the quiet dark canvas. Every edge remains crisp pixel art. No smooth illustration, no blur or added texture.
Constraints: flat opaque background, no border, no vignette, no gradient, no glow halo, no star field, no circuit pattern, no drop shadow, no extra decoration, no tagline, no watermark. Do not thicken the sprite outline or distort lettering. Keep the existing 3:1 horizontal composition.
```
