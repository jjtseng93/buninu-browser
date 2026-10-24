#version 440
layout(location=0) out vec4 fragColor;
layout(binding=1) uniform sampler2D source;
layout(std140,binding=0) uniform buf {vec2 expected;};
void main(){fragColor=textureSize(source,0)==ivec2(expected)?vec4(0,1,0,1):vec4(1,0,0,1);}
