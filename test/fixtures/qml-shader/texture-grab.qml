import QtQuick
Rectangle {
 width:64;height:64;color:"black"
 Image {
  id:input;visible:false
  source:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGP4z8AARAwoFABE0AX7pM/egAAAAABJRU5ErkJggg=="
 }
 ShaderEffect {
  id:probe;width:16;height:16
  property var source:input
  property vector2d expected:Qt.vector2d(2,3)
  fragmentShader:"texture-size.frag"
 }
 Canvas {
  id:reader;width:1;height:1;visible:false
  onImageLoaded:{
   globalThis.grabPixels=Array.from(getContext("2d").createImageData(globalThis.grabUrl).data).slice(0,4);
   unloadImage(globalThis.grabUrl);
   globalThis.unloaded=!isImageLoaded(globalThis.grabUrl);
  }
 }
 Timer {interval:100;running:true;repeat:true;onTriggered:{
  if(input.status===Image.Ready && probe.status===ShaderEffect.Compiled){stop();probe.grabToImage(function(result){globalThis.grabUrl=result.url;reader.loadImage(result.url);},Qt.size(16,16));}
 }}
}
