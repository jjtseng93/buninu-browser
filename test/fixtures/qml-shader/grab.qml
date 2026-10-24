import QtQuick
Rectangle {
 id:root;width:64;height:64;color:"red"
 Canvas {
  id:reader;width:1;height:1;visible:false
  onImageLoaded:{
   var image=getContext("2d").createImageData(globalThis.grabUrl);
   globalThis.grabPixels=Array.from(image.data).slice(0,4);
   unloadImage(globalThis.grabUrl);
   globalThis.unloaded=!isImageLoaded(globalThis.grabUrl);
  }
 }
 Component.onCompleted:Qt.callLater(function(){root.grabToImage(function(result){globalThis.grabUrl=result.url;reader.loadImage(result.url);},Qt.size(16,16));})
}
