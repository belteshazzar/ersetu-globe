//
//  The globe's surface, on the GPU. A direct port of the WebGL shaders in
//  src/globe/gl.ts: a vertex carries the two things that never change - the
//  direction it sits in and its height above sea level - and the shaders do
//  the rest. Exaggeration is one multiply, colour is per fragment, occlusion
//  is the depth buffer.
//

#include <metal_stdlib>
using namespace metal;

struct Uniforms {
    float3x3 rotation;
    float4 bounds;
    float2 centre;
    float2 viewport;
    float lift;
    float radius;
    float overlay;
    float mix;
};

struct VertexIn {
    float3 direction [[attribute(0)]];
    float height [[attribute(1)]];
};

struct VertexOut {
    float4 position [[position]];
    float height;
    float2 disc;
    float3 direction;
};

vertex VertexOut globeVertex(
    VertexIn in [[stage_in]],
    constant Uniforms &u [[buffer(1)]]
) {
    // The whole of the exaggeration control: the vertex holds the shape of the
    // ground, not the shape of this frame's globe.
    float3 world = in.direction * (1.0 + in.height * u.lift);
    float3 view = u.rotation * world;

    // Orthographic, so there is no perspective divide - screen position is the
    // camera-space x and y scaled by the radius the globe is drawn at.
    float2 pixel = u.centre + float2(view.x, -view.y) * u.radius;

    VertexOut out;
    out.height = in.height;
    // Where this lands on the disc, in globe radii, which is all the
    // environment gradient needs: it is fixed to the disc, not to the ground.
    out.disc = view.xy;
    // The undisplaced direction, for the overlay to turn back into a longitude
    // and a latitude.
    out.direction = in.direction;
    out.position = float4(
        pixel.x / u.viewport.x * 2.0 - 1.0,
        1.0 - pixel.y / u.viewport.y * 2.0,
        // Camera-space z runs to about +/-1 globe radius and nearer is larger;
        // Metal clip depth is [0, 1] with nearer winning a LESS test.
        0.5 - view.z * 0.25,
        1.0);
    return out;
}

// paintSphere's inner circle: offset up and left, so the highlight sits where
// a light would put it.
constant float2 FOCUS = float2(-0.25, 0.35);
constant float INNER = 0.05;

constant float3 SKY = float3(0.431, 0.690, 1.000);
constant float3 HORIZON = float3(0.118, 0.361, 0.745);
constant float3 GROUND = float3(0.020, 0.071, 0.204);
constant float HORIZON_STOP = 0.55;

constant float3 LAND = float3(0.322, 0.345, 0.365);
constant float3 LAND_HIGH = float3(0.860, 0.880, 0.900);

fragment float4 globeFragment(
    VertexOut in [[stage_in]],
    constant Uniforms &u [[buffer(0)]],
    texture2d<float> fieldTexture [[texture(0)]],
    texture2d<float> paletteTexture [[texture(1)]],
    texture2d<float> fieldNextTexture [[texture(2)]]
) {
    constexpr sampler linearClamp(mag_filter::linear, min_filter::linear,
                                  address::clamp_to_edge);

    // Canvas interpolates between two circles, so the parameter at a point is
    // how far along the ray from the inner circle it lies - not the plain
    // distance. The ray leaves the outer circle, the unit disc, at "exit".
    float2 offset = in.disc - FOCUS;
    float span = length(offset);
    float2 ray = span > 0.0 ? offset / span : float2(1.0, 0.0);
    float along = dot(FOCUS, ray);
    float exit = -along + sqrt(max(0.0, along * along + 1.0 - dot(FOCUS, FOCUS)));
    float t = clamp((span - INNER) / max(1e-4, exit - INNER), 0.0, 1.0);

    // One environment, lit once, and then two materials in it. Water takes the
    // gradient's colour; rock takes only its brightness and keeps its grey.
    float3 environment = t < HORIZON_STOP
        ? mix(SKY, HORIZON, t / HORIZON_STOP)
        : mix(HORIZON, GROUND, (t - HORIZON_STOP) / (1.0 - HORIZON_STOP));

    float3 colour;
    if (in.height < 0.0) {
        // Bathymetry as brightness rather than hue. Most of the sea floor lies
        // between two and five kilometres down, which is where this ramp
        // spends its range.
        float deep = clamp(-in.height / 6000.0, 0.0, 1.0);
        colour = environment * mix(1.30, 0.45, deep);
    } else {
        // The gradient again, as a light rather than a colour: bright under
        // the highlight, falling away to the limb on the same two stops.
        float shade = t < HORIZON_STOP
            ? mix(1.30, 0.92, t / HORIZON_STOP)
            : mix(0.92, 0.30, (t - HORIZON_STOP) / (1.0 - HORIZON_STOP));
        float3 tone = mix(LAND, LAND_HIGH, clamp(in.height / 3500.0, 0.0, 1.0));
        colour = tone * shade;
    }

    if (u.overlay > 0.0) {
        // Worked out per pixel, not per vertex: longitude jumps the whole way
        // round at the antimeridian, and interpolated across a triangle that
        // smears the entire map through itself. Evaluated here the jump lands
        // between pixels, where it belongs.
        float3 d = normalize(in.direction);
        float east = atan2(d.x, d.z) * 0.1591549431 + 0.5;
        float south = acos(clamp(d.y, -1.0, 1.0)) * 0.3183098862;

        // Measured east from the field's own west edge and wrapped there, so a
        // box crossing the antimeridian needs no special case.
        float2 uv = float2(
            fract(east - u.bounds.x) / u.bounds.y,
            (south - u.bounds.z) / u.bounds.w);

        // Outside its box a field says nothing, which is not the same as
        // saying zero: the ground is left exactly as it was.
        if (uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            // The measurement, then the colour - never the other way about.
            // Mixing the two frames before the ramp is what makes an
            // in-between moment mean something.
            float value = mix(
                fieldTexture.sample(linearClamp, uv).r,
                fieldNextTexture.sample(linearClamp, uv).r,
                u.mix);
            float4 tint = paletteTexture.sample(linearClamp, float2(value, 0.5));
            colour = mix(colour, tint.rgb, tint.a * u.overlay);
        }
    }

    return float4(colour, 1.0);
}
