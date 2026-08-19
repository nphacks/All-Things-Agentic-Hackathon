import "./Loader.css";

interface LoaderProps {
  size?: "sm" | "md" | "lg";
}

export default function Loader({ size = "md" }: LoaderProps) {
  const sizeClass = size === "sm" ? "loader-sm" : size === "lg" ? "loader-lg" : "loader-md";

  return (
    <div className="loader-container">
      <div className={`loader ${sizeClass}`}>
        <div className="crystal"></div>
        <div className="crystal"></div>
        <div className="crystal"></div>
        <div className="crystal"></div>
        <div className="crystal"></div>
        <div className="crystal"></div>
      </div>
    </div>
  );
}
