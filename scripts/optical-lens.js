/* A local optical loupe samples the actual screenshot texture. Its distortion,
   channel dispersion and edge light exist only while inspection is enabled. */
(() => {
  const vertex=`#version 300 es
    in vec2 aPosition;out vec2 uv;
    void main(){uv=(aPosition+1.)*.5;gl_Position=vec4(aPosition,0,1);}`
  const fragment=`#version 300 es
    precision highp float;in vec2 uv;out vec4 frag;
    uniform sampler2D scene;uniform vec2 resolution;uniform vec2 pointer;uniform float enabled;
    vec3 picture(vec2 p){return texture(scene,clamp(p,vec2(0.),vec2(1.))).rgb;}
    void main(){
      vec2 p=vec2(uv.x,1.-uv.y);float aspect=resolution.x/resolution.y;
      vec2 delta=(p-pointer)*vec2(aspect,1.);float radius=.19;
      float dist=length(delta);float body=(1.-smoothstep(radius-.009,radius,dist))*enabled;
      float edge=smoothstep(radius-.048,radius-.005,dist)*body;
      vec2 direction=normalize(delta+vec2(.00001))/vec2(aspect,1.);
      vec2 zoom=pointer+(p-pointer)/1.52;
      vec2 bend=direction*pow(edge,2.)*.022;
      vec3 lens;
      lens.r=picture(zoom+bend*1.08).r;
      lens.g=picture(zoom+bend).g;
      lens.b=picture(zoom+bend*.92).b;
      vec3 base=picture(p);
      float outer=(1.-smoothstep(.0,.014,abs(dist-radius-.012)))*enabled;
      base*=1.-outer*.18;
      float rim=(1.-smoothstep(.0,.0026,abs(dist-radius+.001)))*enabled;
      float arc=max(0.,dot(normalize(delta+vec2(.00001)),normalize(vec2(-.5,-1.))));
      vec3 spectrum=mix(vec3(.63,.69,.94),vec3(.94,.87,.72),p.x);
      frag=vec4(mix(base,lens,body)+rim*spectrum*(.3+arc*.55),1.);
    }`
  function initOpticalLens(canvas,image){
    if(!canvas||!image)return null
    const gl=canvas.getContext('webgl2',{antialias:false,depth:false,powerPreference:'low-power'})
    if(!gl){canvas.dataset.renderer='image';return null}
    let program,locations,texture,buffer,ready=false,enabled=0,frame=0
    let point=[.64,.43],goal=[.64,.43]
    function setup(){
      const shaders=[]
      for(const [kind,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
        const shader=gl.createShader(kind);gl.shaderSource(shader,source);gl.compileShader(shader);shaders.push(shader)
      }
      program=gl.createProgram();shaders.forEach(shader=>gl.attachShader(program,shader));gl.linkProgram(program);shaders.forEach(shader=>gl.deleteShader(shader))
      if(!gl.getProgramParameter(program,gl.LINK_STATUS)){gl.deleteProgram(program);program=null;return false}
      gl.useProgram(program)
      buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW)
      const position=gl.getAttribLocation(program,'aPosition');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0)
      texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR)
      locations=Object.fromEntries(['resolution','pointer','enabled'].map(name=>[name,gl.getUniformLocation(program,name)]))
      return true
    }
    function draw(){
      frame=0
      if(!ready||document.hidden||gl.isContextLost())return
      const dpr=Math.min(devicePixelRatio||1,1.5)
      const w=Math.max(1,Math.round(canvas.clientWidth*dpr)),h=Math.max(1,Math.round(canvas.clientHeight*dpr))
      if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
      point=point.map((value,index)=>value+(goal[index]-value)*.25)
      gl.viewport(0,0,w,h);gl.uniform2f(locations.resolution,w,h);gl.uniform2f(locations.pointer,...point);gl.uniform1f(locations.enabled,enabled)
      gl.drawArrays(gl.TRIANGLES,0,3);canvas.classList.add('is-ready')
      if(enabled&&Math.abs(point[0]-goal[0])+Math.abs(point[1]-goal[1])>.0005)request()
    }
    function request(){if(!frame)frame=requestAnimationFrame(draw)}
    function upload(){
      if(!program||!image.naturalWidth)return
      try{gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);ready=true;canvas.dataset.renderer='webgl2';request()}
      catch{ready=false;canvas.classList.remove('is-ready');canvas.dataset.renderer='image'}
      canvas.dispatchEvent(new CustomEvent('opticalready',{detail:{ready}}))
    }
    if(!setup()){canvas.dataset.renderer='image';return null}
    image.addEventListener('load',upload)
    if(image.complete)upload()
    new ResizeObserver(request).observe(canvas)
    document.addEventListener('visibilitychange',request)
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();ready=false;canvas.classList.remove('is-ready');canvas.dataset.renderer='image';cancelAnimationFrame(frame);frame=0})
    canvas.addEventListener('webglcontextrestored',()=>{if(setup())upload()})
    return {setEnabled(value){enabled=value?1:0;request()},move(x,y){goal=[x,y];request()}}
  }
  window.AICanvasSite=Object.assign(window.AICanvasSite??{},{initOpticalLens})
})()
